# Compute

Most analysis belongs in a local kernel. Reach for a cluster or a GPU when the job genuinely
needs one — and when you do, the job script is an input to the result, not a throwaway.

## Local kernels

```bash
kernel.py start --name main --lang python
kernel.py start --name r    --lang r        # needs R on PATH, or SCIENCE_R_BIN set
```

One kernel per analysis thread. A kernel holds its namespace until stopped, so load once and
iterate. Long cell running away? `kernel.py interrupt --name main` sends SIGINT into the
running code and leaves the namespace intact.

Kernels resolve relative paths against the directory they were started in — start them in the
project root.

R kernels merge stderr into stdout (warnings and messages appear inline), and a top-level
error is caught so the session survives it.

## Threads and memory

Set thread caps before importing numeric libraries, or a shared machine will thrash:

```python
import os
for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[var] = "8"
import numpy as np, scanpy as sc
```

Check what a matrix will cost before allocating it: an `n_cells × n_genes` float32 dense
matrix is `n * m * 4` bytes — 500 000 × 30 000 is 60 GB. Stay sparse, or work backed by disk.

## SLURM over SSH

Generate the script, submit it, poll, retrieve. Keep the script in the repo.

```bash
cat > jobs/de_analysis.sbatch <<'EOF'
#!/bin/bash
#SBATCH --job-name=de_analysis
#SBATCH --output=logs/%x_%j.out
#SBATCH --error=logs/%x_%j.err
#SBATCH --time=04:00:00
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --partition=general

set -euo pipefail
module load python/3.11
source "$PROJECT/.venv/bin/activate"
srun python steps/04_de.py --threads "$SLURM_CPUS_PER_TASK"
EOF

ssh cluster "cd ~/project && sbatch jobs/de_analysis.sbatch"
ssh cluster "squeue -u \$USER -o '%.10i %.30j %.8T %.10M %R'"
ssh cluster "sacct -j JOBID --format=JobID,JobName,State,Elapsed,MaxRSS,ReqMem"
rsync -avz cluster:~/project/results/ results/
```

Rules that save a day each:

- `set -euo pipefail` in every job script — a silent failure that still writes an output file
  is the worst outcome available.
- Request memory from a measured number (`sacct MaxRSS` of a pilot run), not a guess.
- Array jobs for per-sample work: `#SBATCH --array=1-24%6`, index into a sample sheet with
  `$SLURM_ARRAY_TASK_ID`. Keep the sample sheet in the repo; it is an input.
- Write outputs to a job-specific directory so a re-run cannot half-overwrite the last one.
- Never poll with a tight loop over SSH. Check on a sensible interval.

For GPU work add `#SBATCH --gres=gpu:a100:1`, and confirm inside the job that the framework
actually sees the device (`torch.cuda.get_device_name(0)`) before running anything long.

## Modal

For bursty GPU work without a cluster:

```python
import modal

image = modal.Image.debian_slim().pip_install("torch", "transformers")
app = modal.App("science", image=image)

@app.function(gpu="A100", timeout=3600, volumes={"/data": modal.Volume.from_name("data")})
def embed(batch):
    ...

@app.local_entrypoint()
def main():
    results = list(embed.map(batches))
```

Pin the image contents — an unpinned image is an unreproducible environment. Record the
image definition file as `--code` alongside the analysis script.

## Recording remote work

Provenance is captured where the artifact lands. After pulling results back:

```bash
provenance.py record --artifact results/de_results.csv \
  --code steps/04_de.py --code jobs/de_analysis.sbatch \
  --input data/counts.h5ad \
  --command "sbatch jobs/de_analysis.sbatch  # cluster, job 4821573" \
  --note "16 cores, 64 GB, 3h12m wall, MaxRSS 41 GB"
```

The environment snapshot then describes the *local* interpreter, not the cluster's. Say so:
capture `module list` and `pip freeze` from inside the job into `logs/` and record that file
as an input. A manifest that quietly claims the wrong environment is worse than none.

## Choosing where to run

| Situation | Where |
|---|---|
| exploration, plotting, anything under a few minutes | local kernel |
| single dataset, high memory, hours | cluster interactive session or a single batch job |
| the same pipeline over many samples | SLURM array job |
| GPU inference or fine-tuning, no cluster | Modal or an equivalent |
| anything you will repeat next month | a script in `steps/` plus a job file, both committed |
