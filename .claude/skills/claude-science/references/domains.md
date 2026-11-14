# Domain playbooks

Read the relevant section before designing an analysis. Each one lists the conventional tool
chain, the checks that catch the usual silent failures, and the databases to reach for.

---

## Single-cell RNA-seq

**Chain**: `scanpy` / `anndata` (Python) or `Seurat` (R) · `scvi-tools` for integration and
probabilistic models · `scrublet`/`DoubletFinder` · `decoupleR`/`GSEApy` for enrichment ·
`CellTypist` or marker-based annotation.

**Order that works**

1. Load raw counts. Report cells, genes, and per-sample counts *before* any filter.
2. QC per sample, not globally: `n_genes_by_counts`, `total_counts`, `pct_counts_mt`,
   `pct_counts_ribo`. Set thresholds from the distributions you just plotted, and say what
   they were and how many cells each removed.
3. Doublets on each sample separately, before merging.
4. Normalise (`normalize_total` + `log1p`, or `pearson_residuals`), HVGs with `batch_key` set.
5. PCA → integration if batches exist (`harmony`, `scVI`, `scanorama`) → neighbours → UMAP →
   Leiden. Sweep resolution rather than accepting the default.
6. Annotate from markers *and* a reference. Record the evidence per cluster.
7. Differential expression **pseudobulked per sample** (`decoupleR` + `PyDESeq2`/`edgeR`).

**Silent failures**

- Cell-level DE tests treat cells as replicates and inflate significance by orders of
  magnitude. Pseudobulk unless you can defend otherwise.
- Ambient RNA makes every cluster express every marker a little (`SoupX`, `CellBender`).
- Batch and biology confounded by design — no integration method rescues that; check the
  sample sheet before the matrix.
- UMAP distances between clusters mean nothing. Do not describe them.
- Regressing out cell-cycle or mitochondrial fraction can erase real biology in
  proliferating or stressed tissue.

**Databases**: `cellxgene` (references), `ols --by cl` (cell ontology), `mygene`/`hgnc`
(symbols), `quickgo`, `reactome`, `string`.

---

## Bulk RNA-seq and genomics

**Chain**: `fastp`/`cutadapt` · `STAR`/`HISAT2` or `salmon`/`kallisto` · `featureCounts` ·
`DESeq2`/`edgeR`/`limma-voom` · `bcftools`/`GATK` for variants · `bedtools`/`pybedtools`.

**Order that works**

1. QC the reads (`fastqc`/`multiqc`) and keep the report as an artifact.
2. Quantify. Record the exact annotation release — GENCODE v44 and v29 are different answers.
3. Build the design matrix explicitly and print it. Check rank and confounding before fitting.
4. Fit, shrink log-fold-changes (`apeglm`/`ashr`), adjust p-values (BH), and report both the
   effect size and the adjusted p-value — never the p-value alone.
5. Enrichment against a background of *expressed* genes, not the whole genome.

**Silent failures**

- Reference/annotation mismatch between alignment and counting.
- Unstranded quantification of a stranded library (or the reverse) — check the strandedness
  before trusting counts.
- Batch confounded with condition; `~ batch + condition` cannot save a design where every
  case was run on day 1 and every control on day 2.
- Filtering low-count genes after multiple-testing correction instead of before.
- Reporting "n genes changed" without a fold-change threshold or the total tested.

**Databases**: `ensembl`, `datasets`, `ncbi` (`gene`, `nuccore`, `gds` for GEO), `gwas`,
`opentargets`, `hgnc`, `reactome`, `quickgo`.

---

## Proteomics

**Chain**: `MaxQuant`/`FragPipe`/`DIA-NN` upstream · `pandas` + `limma`/`MSstats` downstream ·
`pyteomics` for spectra and FASTA handling.

**Order that works**

1. Start from the evidence/report table, not the summary. Record the search settings: enzyme,
   missed cleavages, fixed and variable modifications, FDR level, match-between-runs.
2. Filter contaminants and decoys explicitly and report how many were removed.
3. Log2-transform, then normalise (median or VSN). Plot per-run distributions before and after.
4. Missing values are not zeros. Decide MAR vs MNAR and impute accordingly (or model it) —
   state which, per protein group if mixed.
5. Test with moderated statistics (`limma`); report protein-level FDR.

**Silent failures**

- Zero-imputation of MNAR values manufactures fold changes at the detection limit.
- Protein-group ambiguity: a "protein" quantified from shared peptides only is not a
  measurement of that protein.
- Normalising away a real global shift (e.g. a treatment that halves total translation).
- iBAQ/LFQ intensities compared across experiments processed with different search settings.

**Databases**: `pride`, `uniprot` (`fasta` for search databases), `interpro`, `string`,
`reactome`, `quickgo`.

---

## Structural biology

**Chain**: `biotite`/`Biopython`/`gemmi` for parsing · `pymol`/`nglview`/`py3Dmol` for
inspection · `foldseek` for structure search · AlphaFold/Boltz/OpenFold for prediction ·
`MDAnalysis` for trajectories.

**Order that works**

1. Fetch the structure and read the header: resolution, R-free, missing residues, ligands,
   crystallographic contacts, and whether the deposited assembly is the biological one.
2. For predictions, treat pLDDT and PAE as first-class: low-pLDDT regions are often genuinely
   disordered, and inter-domain PAE tells you whether a relative orientation means anything.
3. Map features (domains, variants, active sites) by *sequence position translated through
   SIFTS/UniProt numbering* — PDB numbering is not sequence numbering.
4. Superpose with a stated method and report RMSD with the residue selection used.

**Silent failures**

- Comparing a predicted monomer against a crystal dimer interface.
- Ignoring alternate conformations and occupancy < 1.
- Quoting an RMSD without saying over which atoms and which residues.
- Treating a high-pLDDT loop as evidence of a specific conformation; confidence is not
  dynamics.

**Databases**: `pdb`, `alphafold`, `uniprot`, `interpro`, `ols`.

---

## Cheminformatics

**Chain**: `rdkit` · `datamol` · `useful_rdkit_utils` · `scikit-learn`/`xgboost` for QSAR ·
`chembl_webresource_client` or `dbfetch.py chembl`.

**Order that works**

1. Standardise every structure before anything else: sanitise, remove salts, neutralise,
   canonical tautomer, canonical SMILES. Record the standardisation code as an input.
2. Deduplicate on InChIKey after standardisation, not on input SMILES.
3. Curate activity data: single assay type, single unit, aggregate replicates explicitly,
   and drop censored values (`>`, `<`) or model them — never silently coerce.
4. Split by scaffold or by time for model evaluation. Random splits on congeneric series
   report a fantasy.
5. Report applicability domain alongside performance.

**Silent failures**

- Activity cliffs plus a random split → excellent metrics, useless model.
- Mixing IC50 and Ki, or nM and µM, in one column.
- Descriptors computed before standardisation.
- Duplicate molecules spanning train and test through different SMILES for the same compound.

**Databases**: `chembl`, `pubchem`, `ols --by chebi`, `pride` (targets), `opentargets`.

---

## Phylogenetics and evolution

**Chain**: `MAFFT`/`MUSCLE` · `trimAl` · `IQ-TREE`/`RAxML-NG` · `MrBayes`/`BEAST` ·
`ete3`/`Bio.Phylo`/`toytree` for handling and plotting · `HyPhy`/`PAML` for selection.

**Order that works**

1. Assemble orthologues deliberately (OrthoFinder, Ensembl Compara, OMA) — a BLAST hit is not
   an orthologue.
2. Align, then inspect the alignment. Trim with a stated method and report columns removed.
3. Select a substitution model (`ModelFinder`) rather than defaulting to one.
4. Infer with support: ≥1000 ultrafast bootstraps or aLRT; report the values on the figure.
5. Root explicitly with an outgroup and say so. Midpoint rooting is an assumption, not a
   default.

**Silent failures**

- Long-branch attraction from a distant outgroup or a fast-evolving taxon.
- Paralogues in the alignment producing a "surprising" topology.
- Support values dropped from the published figure.
- Ancestral-state reconstruction reported without the uncertainty it comes with.
- Concatenating genes with conflicting histories and reporting one tree as the species tree.

**Databases**: `ensembl homology`, `uniprot`, `ncbi` (`protein`, `taxonomy`), `interpro`.

---

## Applies everywhere

- Plot the raw distribution before you summarise it.
- State n, and what n counts (cells? samples? patients?) — one of these is your real
  replicate and the others are pseudoreplication.
- Multiple testing correction is not optional, and choosing the method after seeing results
  is not correction.
- Effect size and uncertainty, always, alongside any p-value.
- A pipeline that runs to completion is not a pipeline that worked. Check intermediate
  outputs against expectations you wrote down beforehand.
