# Scientific databases

`scripts/dbfetch.py` wraps the open REST APIs behind one CLI, caches every response under
`.science/cache/`, and appends each retrieval to the ledger. `dbfetch.py list` prints the
table; `dbfetch.py help DB` prints one database's operations.

## Built-in databases

| Database | Operations | Notes |
|---|---|---|
| `uniprot` | `get ACC` · `fasta ACC` · `search 'QUERY'` | query syntax: `gene:TP53 AND organism_id:9606 AND reviewed:true` |
| `pdb` | `get ID` · `search 'TEXT'` · `polymer ID ENTITY` · `download ID --fmt cif\|pdb` | RCSB data + search API |
| `alphafold` | `get ACC` · `download ACC --fmt pdb\|cif\|bcif` | `download` resolves the current model version from the API |
| `ncbi` | `search DB 'TERM'` · `summary DB IDS` · `fetch DB IDS --fmt abstract\|fasta\|gb\|xml` · `link FROM TO ID` | DBs: `pubmed`, `gene`, `nuccore`, `protein`, `sra`, `gds` (GEO), `clinvar`, `snp`, `taxonomy` |
| `pubmed` | `search 'TERM'` · `abstract PMIDS` · `summary PMIDS` | shorthand over E-utilities |
| `datasets` | `gene SYMBOL --taxon 9606` · `genome ACCESSION` | NCBI Datasets v2 |
| `ensembl` | `lookup ID` · `symbol SYM --species` · `sequence ID --fmt cdna\|protein\|genomic` · `xrefs ID` · `variants ID` · `homology ID` | |
| `chembl` | `get ID` · `search 'NAME'` · `activities TARGET_ID` · `target 'NAME'` | bioactivity + compounds |
| `pubchem` | `get ID --by name\|cid\|smiles\|inchikey` · `properties ID` · `synonyms ID` · `sdf ID` | PUG REST |
| `kegg` | `get ENTRY` · `find DB 'QUERY'` · `link TARGET SOURCE` · `conv TARGET SOURCE` | plain-text responses; use `--format raw` |
| `reactome` | `search 'QUERY'` · `get STABLE_ID` · `pathways UNIPROT_ACC` | |
| `string` | `network GENES` · `partners GENE` · `enrichment GENES` | join multiple genes with `%0d`; `--taxon 9606` |
| `interpro` | `protein ACC` · `entry IPR_ID` · `search 'TEXT'` | domains and families |
| `gwas` | `gene SYMBOL` · `variant rsID` · `trait 'TRAIT'` | GWAS Catalog |
| `opentargets` | `target ENSG` · `associations ENSG` · `disease EFO` | GraphQL under the hood |
| `europepmc` | `search 'QUERY'` · `citations SOURCE ID` · `references SOURCE ID` | full-text search incl. preprints |
| `crossref` | `doi DOI` · `search 'QUERY'` | set `CROSSREF_MAILTO` for the polite pool |
| `biorxiv` | `details DOI --by biorxiv\|medrxiv` · `recent RANGE` | |
| `hgnc` | `symbol SYM` · `search 'TEXT'` | authoritative human gene symbols |
| `mygene` | `query 'TEXT'` · `get GENE_ID` | fast ID conversion |
| `ols` | `search 'TERM' --by efo\|go\|mondo\|uberon\|cl` · `term ONTOLOGY ID` | ontology lookup |
| `quickgo` | `search 'TERM'` · `annotations ACC` | GO annotations with evidence codes |
| `pride` | `search 'KEYWORD'` · `get PXD` | proteomics datasets |
| `encode` | `search 'TERM'` · `get ACCESSION` | functional genomics |
| `cellxgene` | `collections` · `get COLLECTION_ID` | single-cell collections |

## Output control

```bash
dbfetch.py uniprot search 'gene:TP53 AND reviewed:true' --limit 5 --format tsv
dbfetch.py uniprot get P04637 --select 'sequence.value'
dbfetch.py pubmed search 'spatial transcriptomics' --limit 50 --format tsv --out results/hits.tsv
dbfetch.py kegg get hsa04115 --format raw
```

- `--format json` (default) · `tsv` (curated columns, where the operation defines them) ·
  `raw` (untouched body — required for KEGG and FASTA)
- `--select a.b.0.c` walks the JSON; a list segment maps over its elements
- `--out FILE|DIR` writes instead of printing; binary operations (`download`, `sdf`) require it
- `--no-cache` forces a refetch; `--quiet` suppresses the cache-hit line

## Keys, rate limits, etiquette

- **NCBI**: 3 requests/second anonymous, 10/second with `NCBI_API_KEY` set. `dbfetch.py`
  sleeps between calls and forwards the key when the variable is present.
- **Crossref**: set `CROSSREF_MAILTO=you@example.org` for faster, more reliable service.
- **EBI services** (UniProt, InterPro, GWAS, PRIDE, OLS, QuickGO, EuropePMC): no key; be
  reasonable with `--limit`.
- **KEGG**: free for academic use; commercial use requires a licence.
- Cached responses mean a rerun costs nothing. Do not defeat the cache in a loop.

## Provenance of retrieved data

Every fetch appends to `.science/ledger.jsonl` with the URL and a request hash, and the
body is stored in `.science/cache/<request-hash>.json`. When a figure depends on downloaded
records, treat the cache entry as an input:

```bash
dbfetch.py gwas gene TP53 --format tsv --out results/tp53_gwas.tsv
provenance.py record --artifact figures/fig5_gwas.png \
  --code steps/06_gwas.py --input results/tp53_gwas.tsv
```

The database releases behind these APIs move. Record the retrieval date (the ledger does it
for you) and say in the methods which release you pulled, not just which database.

## Beyond the built-ins

Other resources worth reaching for, usable directly with `curl` or a client library —
add the ones you use often as a handler in `dbfetch.py` (one function returning a `Req`,
one row in `REGISTRY`):

**Sequence & genome** — RefSeq, GENCODE, UCSC (`api.genome.ucsc.edu`), 1000 Genomes,
gnomAD (GraphQL, `gnomad.broadinstitute.org/api`), dbSNP, dbVar, ClinGen, DECIPHER,
Ensembl VEP REST.
**Expression** — GEO, ArrayExpress/BioStudies, GTEx (`gtexportal.org/api/v2`),
Expression Atlas, recount3, Human Cell Atlas Data Portal, Single Cell Portal.
**Protein & structure** — PDBe, PDBe-KB, SWISS-MODEL Repository, ESM Atlas, SIFTS,
Pfam (via InterPro), CATH, SCOP, PROSITE, ProteomicsDB, PeptideAtlas, MassIVE.
**Interactions & pathways** — IntAct, BioGRID, CORUM, OmniPath, WikiPathways, SIGNOR,
Reactome analysis service, MSigDB.
**Chemistry** — ChEBI, DrugBank (licence), BindingDB, ZINC, SureChEMBL, Open Reaction
Database, CCDC/COD, NMRShiftDB, ChemSpider (key).
**Clinical & pharmacology** — ClinicalTrials.gov v2 API, OpenFDA, DailyMed, RxNorm, UMLS
(licence), MONDO/HPO via OLS, Orphanet.
**Phylogeny & taxonomy** — NCBI Taxonomy, GBIF, OpenTree of Life, TimeTree, Silva, GTDB.
**Literature** — PubMed Central OA, Semantic Scholar, OpenAlex, bioRxiv/medRxiv, arXiv.

Prefer a resource with a stable identifier scheme and a documented release cadence. If a
lookup cannot be pinned to an identifier, it does not belong in the methods section.
