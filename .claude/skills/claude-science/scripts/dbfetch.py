#!/usr/bin/env python3
"""One CLI over the open scientific database REST APIs, with caching + provenance.

    dbfetch.py list                                   # every database and operation
    dbfetch.py help uniprot                           # operations for one database
    dbfetch.py uniprot get P04637
    dbfetch.py uniprot search 'gene:TP53 AND organism_id:9606' --limit 5 --format tsv
    dbfetch.py alphafold download P04637 --out structures/
    dbfetch.py ncbi search pubmed 'single-cell CRISPR screen' --limit 20
    dbfetch.py opentargets associations ENSG00000141510

Responses are cached under .science/cache/ keyed by the request, and every fetch is
appended to .science/ledger.jsonl so a figure can be traced back to the exact record
that fed it. Stdlib only; honours HTTP(S)_PROXY.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import provenance  # noqa: E402  (sibling script)

USER_AGENT = "claude-science-dbfetch/1.0 (https://claude.com/docs/claude-science)"
TIMEOUT = 60


class Req:
    def __init__(self, url, headers=None, method="GET", body=None, binary=False, table=None):
        self.url = url
        self.headers = headers or {}
        self.method = method
        self.body = body
        self.binary = binary
        self.table = table  # callable(payload) -> list[dict], for --format tsv

    def key(self) -> str:
        raw = f"{self.method} {self.url} {self.body or ''}"
        return hashlib.sha256(raw.encode()).hexdigest()


def q(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


def qk(value: str) -> str:
    """Quote but keep ':' - KEGG and a few others use it inside path segments."""
    return urllib.parse.quote(str(value), safe=":")


def need(args: list[str], count: int, usage: str) -> None:
    if len(args) < count:
        raise SystemExit(f"usage: dbfetch.py {usage}")


def _get_json(url: str):
    """Small helper for handlers that must resolve one URL before returning a request."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:  # noqa: S310
            return json.loads(response.read().decode())
    except (urllib.error.URLError, ValueError) as exc:
        raise SystemExit(f"lookup failed for {url}: {exc}") from None


# --------------------------------------------------------------------------- handlers


def uniprot(op, a, o):
    fields = "accession,id,protein_name,gene_names,organism_name,length,cc_function"
    if op == "get":
        need(a, 1, "uniprot get ACCESSION")
        return Req(f"https://rest.uniprot.org/uniprotkb/{q(a[0])}.json")
    if op == "fasta":
        need(a, 1, "uniprot fasta ACCESSION")
        return Req(f"https://rest.uniprot.org/uniprotkb/{q(a[0])}.fasta")
    if op == "search":
        need(a, 1, "uniprot search 'QUERY'")
        url = (
            "https://rest.uniprot.org/uniprotkb/search?"
            f"query={q(a[0])}&size={o.limit}&format=json&fields={q(fields)}"
        )
        return Req(url, table=lambda p: [
            {
                "accession": r.get("primaryAccession"),
                "gene": (r.get("genes") or [{}])[0].get("geneName", {}).get("value"),
                "protein": (r.get("proteinDescription", {}).get("recommendedName", {})
                            .get("fullName", {}).get("value")),
                "organism": r.get("organism", {}).get("scientificName"),
                "length": r.get("sequence", {}).get("length"),
            }
            for r in p.get("results", [])
        ])
    raise SystemExit(f"unknown uniprot operation '{op}' (get, fasta, search)")


def pdb(op, a, o):
    if op == "get":
        need(a, 1, "pdb get PDBID")
        return Req(f"https://data.rcsb.org/rest/v1/core/entry/{q(a[0].upper())}")
    if op == "polymer":
        need(a, 2, "pdb polymer PDBID ENTITYID")
        return Req(
            f"https://data.rcsb.org/rest/v1/core/polymer_entity/{q(a[0].upper())}/{q(a[1])}"
        )
    if op == "download":
        need(a, 1, "pdb download PDBID [--fmt cif|pdb]")
        fmt = o.fmt or "cif"
        return Req(f"https://files.rcsb.org/download/{q(a[0].upper())}.{fmt}", binary=True)
    if op == "search":
        need(a, 1, "pdb search 'TEXT'")
        query = {
            "query": {
                "type": "terminal",
                "service": "full_text",
                "parameters": {"value": a[0]},
            },
            "return_type": "entry",
            "request_options": {"paginate": {"start": 0, "rows": o.limit}},
        }
        url = "https://search.rcsb.org/rcsbsearch/v2/query?json=" + q(json.dumps(query))
        return Req(url, table=lambda p: [
            {"pdb_id": r.get("identifier"), "score": round(r.get("score", 0), 3)}
            for r in p.get("result_set", [])
        ])
    raise SystemExit(f"unknown pdb operation '{op}' (get, search, polymer, download)")


def alphafold(op, a, o):
    if op == "get":
        need(a, 1, "alphafold get UNIPROT_ACC")
        return Req(f"https://alphafold.ebi.ac.uk/api/prediction/{q(a[0].upper())}")
    if op == "download":
        need(a, 1, "alphafold download UNIPROT_ACC [--fmt cif|pdb]")
        fmt = (o.fmt or "pdb").lower()
        acc = a[0].upper()
        # Resolve the current model URL rather than guessing the version suffix.
        prediction = _get_json(f"https://alphafold.ebi.ac.uk/api/prediction/{q(acc)}")
        if not prediction:
            raise SystemExit(f"no AlphaFold prediction for {acc}")
        key = {"pdb": "pdbUrl", "cif": "cifUrl", "bcif": "bcifUrl"}.get(fmt)
        url = prediction[0].get(key) if key else None
        if not url:
            raise SystemExit(f"AlphaFold has no {fmt} file for {acc}")
        return Req(url, binary=True)
    raise SystemExit(f"unknown alphafold operation '{op}' (get, download)")


def ncbi(op, a, o):
    base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
    key = os.environ.get("NCBI_API_KEY")
    suffix = f"&api_key={q(key)}" if key else ""
    tool = "&tool=claude-science"
    if op == "search":
        need(a, 2, "ncbi search DB 'TERM'   (db: pubmed, gene, nuccore, protein, sra, gds, ...)")
        url = (
            f"{base}/esearch.fcgi?db={q(a[0])}&term={q(a[1])}&retmax={o.limit}"
            f"&retmode=json{tool}{suffix}"
        )
        return Req(url, table=lambda p: [
            {"id": i} for i in p.get("esearchresult", {}).get("idlist", [])
        ])
    if op == "summary":
        need(a, 2, "ncbi summary DB ID[,ID...]")
        url = f"{base}/esummary.fcgi?db={q(a[0])}&id={q(a[1])}&retmode=json{tool}{suffix}"
        return Req(url)
    if op == "fetch":
        need(a, 2, "ncbi fetch DB ID[,ID...] [--fmt abstract|fasta|gb|xml]")
        fmt = o.fmt or "abstract"
        rettype = {"abstract": "abstract", "fasta": "fasta", "gb": "gb", "xml": "null"}.get(fmt, fmt)
        retmode = "xml" if fmt == "xml" else "text"
        url = (
            f"{base}/efetch.fcgi?db={q(a[0])}&id={q(a[1])}&rettype={q(rettype)}"
            f"&retmode={retmode}{tool}{suffix}"
        )
        return Req(url)
    if op == "link":
        need(a, 3, "ncbi link FROMDB TODB ID")
        url = (
            f"{base}/elink.fcgi?dbfrom={q(a[0])}&db={q(a[1])}&id={q(a[2])}"
            f"&retmode=json{tool}{suffix}"
        )
        return Req(url)
    raise SystemExit(f"unknown ncbi operation '{op}' (search, summary, fetch, link)")


def pubmed(op, a, o):
    """Convenience alias over the E-utilities."""
    if op == "search":
        need(a, 1, "pubmed search 'TERM'")
        return ncbi("search", ["pubmed", a[0]], o)
    if op == "abstract":
        need(a, 1, "pubmed abstract PMID[,PMID...]")
        o.fmt = o.fmt or "abstract"
        return ncbi("fetch", ["pubmed", a[0]], o)
    if op == "summary":
        need(a, 1, "pubmed summary PMID[,PMID...]")
        return ncbi("summary", ["pubmed", a[0]], o)
    raise SystemExit(f"unknown pubmed operation '{op}' (search, abstract, summary)")


def ensembl(op, a, o):
    base = "https://rest.ensembl.org"
    json_hdr = {"Accept": "application/json"}
    if op == "lookup":
        need(a, 1, "ensembl lookup ENSEMBL_ID")
        return Req(f"{base}/lookup/id/{q(a[0])}?expand=1", headers=json_hdr)
    if op == "symbol":
        need(a, 1, "ensembl symbol SYMBOL [--species homo_sapiens]")
        species = o.species or "homo_sapiens"
        return Req(f"{base}/lookup/symbol/{q(species)}/{q(a[0])}?expand=1", headers=json_hdr)
    if op == "sequence":
        need(a, 1, "ensembl sequence ENSEMBL_ID [--fmt cdna|protein|genomic]")
        query = f"?type={q(o.fmt)}" if o.fmt else ""
        return Req(f"{base}/sequence/id/{q(a[0])}{query}", headers={"Accept": "text/x-fasta"})
    if op == "xrefs":
        need(a, 1, "ensembl xrefs ENSEMBL_ID")
        return Req(f"{base}/xrefs/id/{q(a[0])}", headers=json_hdr)
    if op == "variants":
        need(a, 1, "ensembl variants ENSEMBL_ID")
        return Req(f"{base}/overlap/id/{q(a[0])}?feature=variation", headers=json_hdr)
    if op == "homology":
        need(a, 1, "ensembl homology ENSEMBL_ID")
        return Req(f"{base}/homology/id/{q(a[0])}?type=orthologues", headers=json_hdr)
    raise SystemExit(
        f"unknown ensembl operation '{op}' (lookup, symbol, sequence, xrefs, variants, homology)"
    )


def chembl(op, a, o):
    base = "https://www.ebi.ac.uk/chembl/api/data"
    if op == "get":
        need(a, 1, "chembl get CHEMBL_ID")
        return Req(f"{base}/molecule/{q(a[0].upper())}.json")
    if op == "search":
        need(a, 1, "chembl search 'NAME'")
        url = f"{base}/molecule/search.json?q={q(a[0])}&limit={o.limit}"
        return Req(url, table=lambda p: [
            {
                "chembl_id": m.get("molecule_chembl_id"),
                "name": m.get("pref_name"),
                "max_phase": m.get("max_phase"),
                "smiles": (m.get("molecule_structures") or {}).get("canonical_smiles"),
            }
            for m in p.get("molecules", [])
        ])
    if op == "activities":
        need(a, 1, "chembl activities CHEMBL_TARGET_ID")
        url = f"{base}/activity.json?target_chembl_id={q(a[0].upper())}&limit={o.limit}"
        return Req(url, table=lambda p: [
            {
                "molecule": r.get("molecule_chembl_id"),
                "type": r.get("standard_type"),
                "value": r.get("standard_value"),
                "units": r.get("standard_units"),
                "assay": r.get("assay_chembl_id"),
            }
            for r in p.get("activities", [])
        ])
    if op == "target":
        need(a, 1, "chembl target 'NAME'")
        return Req(f"{base}/target/search.json?q={q(a[0])}&limit={o.limit}")
    raise SystemExit(f"unknown chembl operation '{op}' (get, search, activities, target)")


def pubchem(op, a, o):
    base = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound"
    namespace = o.by or "name"
    if op == "get":
        need(a, 1, "pubchem get IDENTIFIER [--by name|cid|smiles|inchikey]")
        return Req(f"{base}/{q(namespace)}/{q(a[0])}/JSON")
    if op == "properties":
        need(a, 1, "pubchem properties IDENTIFIER [--by name|cid|smiles]")
        props = "MolecularFormula,MolecularWeight,CanonicalSMILES,InChIKey,XLogP,TPSA"
        url = f"{base}/{q(namespace)}/{q(a[0])}/property/{props}/JSON"
        return Req(url, table=lambda p: p.get("PropertyTable", {}).get("Properties", []))
    if op == "synonyms":
        need(a, 1, "pubchem synonyms IDENTIFIER")
        return Req(f"{base}/{q(namespace)}/{q(a[0])}/synonyms/JSON")
    if op == "sdf":
        need(a, 1, "pubchem sdf IDENTIFIER")
        return Req(f"{base}/{q(namespace)}/{q(a[0])}/SDF", binary=True)
    raise SystemExit(f"unknown pubchem operation '{op}' (get, properties, synonyms, sdf)")


def kegg(op, a, o):
    base = "https://rest.kegg.jp"
    if op == "get":
        need(a, 1, "kegg get ENTRY   (e.g. hsa:7157, path:hsa04115)")
        return Req(f"{base}/get/{qk(a[0])}")
    if op == "find":
        need(a, 2, "kegg find DB 'QUERY'   (db: genes, pathway, compound, drug)")
        return Req(f"{base}/find/{qk(a[0])}/{q(a[1])}")
    if op == "link":
        need(a, 2, "kegg link TARGET_DB SOURCE   (e.g. pathway hsa:7157)")
        return Req(f"{base}/link/{qk(a[0])}/{qk(a[1])}")
    if op == "conv":
        need(a, 2, "kegg conv TARGET_DB SOURCE")
        return Req(f"{base}/conv/{qk(a[0])}/{qk(a[1])}")
    raise SystemExit(f"unknown kegg operation '{op}' (get, find, link, conv)")


def reactome(op, a, o):
    base = "https://reactome.org/ContentService"
    if op == "search":
        need(a, 1, "reactome search 'QUERY'")
        species = o.species or "Homo sapiens"
        return Req(f"{base}/search/query?query={q(a[0])}&species={q(species)}&cluster=true")
    if op == "get":
        need(a, 1, "reactome get STABLE_ID")
        return Req(f"{base}/data/query/{q(a[0])}")
    if op == "pathways":
        need(a, 1, "reactome pathways UNIPROT_ACC")
        species = o.species or "Homo sapiens"
        url = f"{base}/data/mapping/UniProt/{q(a[0].upper())}/pathways?species={q(species)}"
        return Req(url, table=lambda p: [
            {"stId": r.get("stId"), "name": r.get("displayName")} for r in (p or [])
        ])
    raise SystemExit(f"unknown reactome operation '{op}' (search, get, pathways)")


def string_db(op, a, o):
    base = "https://string-db.org/api/json"
    species = o.taxon or "9606"
    if op == "network":
        need(a, 1, "string network GENE[%0dGENE...]")
        return Req(f"{base}/network?identifiers={q(a[0])}&species={q(species)}")
    if op == "partners":
        need(a, 1, "string partners GENE")
        url = f"{base}/interaction_partners?identifiers={q(a[0])}&species={q(species)}&limit={o.limit}"
        return Req(url, table=lambda p: [
            {"a": r.get("preferredName_A"), "b": r.get("preferredName_B"), "score": r.get("score")}
            for r in (p or [])
        ])
    if op == "enrichment":
        need(a, 1, "string enrichment GENE%0dGENE%0d...")
        url = f"{base}/enrichment?identifiers={q(a[0])}&species={q(species)}"
        return Req(url, table=lambda p: [
            {
                "category": r.get("category"),
                "term": r.get("term"),
                "description": r.get("description"),
                "fdr": r.get("fdr"),
            }
            for r in (p or [])
        ])
    raise SystemExit(f"unknown string operation '{op}' (network, partners, enrichment)")


def interpro(op, a, o):
    base = "https://www.ebi.ac.uk/interpro/api"
    if op == "protein":
        need(a, 1, "interpro protein UNIPROT_ACC")
        return Req(f"{base}/entry/all/protein/uniprot/{q(a[0].upper())}?page_size={o.limit}")
    if op == "entry":
        need(a, 1, "interpro entry IPR_ID")
        return Req(f"{base}/entry/interpro/{q(a[0].upper())}")
    if op == "search":
        need(a, 1, "interpro search 'TEXT'")
        return Req(f"{base}/entry/interpro/?search={q(a[0])}&page_size={o.limit}")
    raise SystemExit(f"unknown interpro operation '{op}' (protein, entry, search)")


def gwas(op, a, o):
    base = "https://www.ebi.ac.uk/gwas/rest/api"
    if op == "gene":
        need(a, 1, "gwas gene SYMBOL")
        return Req(f"{base}/genes/{q(a[0].upper())}/associations?size={o.limit}")
    if op == "variant":
        need(a, 1, "gwas variant rsID")
        return Req(f"{base}/singleNucleotidePolymorphisms/{q(a[0])}/associations?size={o.limit}")
    if op == "trait":
        need(a, 1, "gwas trait 'DISEASE TRAIT'")
        return Req(
            f"{base}/studies/search/findByDiseaseTrait?diseaseTrait={q(a[0])}&size={o.limit}"
        )
    raise SystemExit(f"unknown gwas operation '{op}' (gene, variant, trait)")


def opentargets(op, a, o):
    url = "https://api.platform.opentargets.org/api/v4/graphql"
    headers = {"Content-Type": "application/json"}
    if op == "target":
        need(a, 1, "opentargets target ENSG_ID")
        query = """query($id:String!){target(ensemblId:$id){
            id approvedSymbol approvedName biotype
            proteinIds{id source}
            tractability{label modality value}}}"""
        variables = {"id": a[0]}
    elif op == "associations":
        need(a, 1, "opentargets associations ENSG_ID")
        query = """query($id:String!,$size:Int!){target(ensemblId:$id){
            approvedSymbol
            associatedDiseases(page:{index:0,size:$size}){count rows{
                score disease{id name}}}}}"""
        variables = {"id": a[0], "size": o.limit}
    elif op == "disease":
        need(a, 1, "opentargets disease EFO_ID")
        query = """query($id:String!,$size:Int!){disease(efoId:$id){
            id name description
            associatedTargets(page:{index:0,size:$size}){count rows{
                score target{id approvedSymbol}}}}}"""
        variables = {"id": a[0], "size": o.limit}
    else:
        raise SystemExit(f"unknown opentargets operation '{op}' (target, associations, disease)")
    body = json.dumps({"query": " ".join(query.split()), "variables": variables})
    return Req(url, headers=headers, method="POST", body=body)


def europepmc(op, a, o):
    base = "https://www.ebi.ac.uk/europepmc/webservices/rest"
    if op == "search":
        need(a, 1, "europepmc search 'QUERY'")
        url = f"{base}/search?query={q(a[0])}&format=json&pageSize={o.limit}&resultType=core"
        return Req(url, table=lambda p: [
            {
                "id": r.get("id"),
                "pmid": r.get("pmid"),
                "doi": r.get("doi"),
                "year": r.get("pubYear"),
                "journal": r.get("journalTitle"),
                "title": r.get("title"),
            }
            for r in p.get("resultList", {}).get("result", [])
        ])
    if op == "citations":
        need(a, 2, "europepmc citations SOURCE ID   (e.g. MED 26538614)")
        return Req(f"{base}/{q(a[0])}/{q(a[1])}/citations?format=json&pageSize={o.limit}")
    if op == "references":
        need(a, 2, "europepmc references SOURCE ID")
        return Req(f"{base}/{q(a[0])}/{q(a[1])}/references?format=json&pageSize={o.limit}")
    raise SystemExit(f"unknown europepmc operation '{op}' (search, citations, references)")


def crossref(op, a, o):
    base = "https://api.crossref.org"
    mail = os.environ.get("CROSSREF_MAILTO")
    tail = f"&mailto={q(mail)}" if mail else ""
    if op == "doi":
        need(a, 1, "crossref doi 10.xxxx/yyyy")
        return Req(f"{base}/works/{urllib.parse.quote(a[0], safe='/')}")
    if op == "search":
        need(a, 1, "crossref search 'QUERY'")
        url = f"{base}/works?query.bibliographic={q(a[0])}&rows={o.limit}{tail}"
        return Req(url, table=lambda p: [
            {
                "doi": r.get("DOI"),
                "year": (r.get("issued", {}).get("date-parts") or [[None]])[0][0],
                "title": (r.get("title") or [""])[0],
                "container": (r.get("container-title") or [""])[0],
            }
            for r in p.get("message", {}).get("items", [])
        ])
    raise SystemExit(f"unknown crossref operation '{op}' (doi, search)")


def biorxiv(op, a, o):
    if op == "details":
        need(a, 1, "biorxiv details 10.1101/xxxxx [--server biorxiv|medrxiv]")
        server = o.by or "biorxiv"
        return Req(f"https://api.biorxiv.org/details/{q(server)}/{urllib.parse.quote(a[0])}")
    if op == "recent":
        need(a, 1, "biorxiv recent YYYY-MM-DD/YYYY-MM-DD")
        server = o.by or "biorxiv"
        return Req(f"https://api.biorxiv.org/details/{q(server)}/{a[0]}")
    raise SystemExit(f"unknown biorxiv operation '{op}' (details, recent)")


def hgnc(op, a, o):
    base = "https://rest.genenames.org"
    headers = {"Accept": "application/json"}
    if op == "symbol":
        need(a, 1, "hgnc symbol SYMBOL")
        return Req(f"{base}/fetch/symbol/{q(a[0].upper())}", headers=headers)
    if op == "search":
        need(a, 1, "hgnc search 'TEXT'")
        return Req(f"{base}/search/{q(a[0])}", headers=headers)
    raise SystemExit(f"unknown hgnc operation '{op}' (symbol, search)")


def mygene(op, a, o):
    if op == "query":
        need(a, 1, "mygene query 'TEXT'")
        url = f"https://mygene.info/v3/query?q={q(a[0])}&size={o.limit}&species={q(o.species or 'human')}"
        return Req(url, table=lambda p: p.get("hits", []))
    if op == "get":
        need(a, 1, "mygene get GENE_ID")
        return Req(f"https://mygene.info/v3/gene/{q(a[0])}")
    raise SystemExit(f"unknown mygene operation '{op}' (query, get)")


def ols(op, a, o):
    base = "https://www.ebi.ac.uk/ols4/api"
    if op == "search":
        need(a, 1, "ols search 'TERM' [--by efo|go|mondo|uberon|cl]")
        ontology = f"&ontology={q(o.by)}" if o.by else ""
        url = f"{base}/search?q={q(a[0])}&rows={o.limit}{ontology}"
        return Req(url, table=lambda p: [
            {"id": d.get("obo_id"), "label": d.get("label"), "ontology": d.get("ontology_name")}
            for d in p.get("response", {}).get("docs", [])
        ])
    if op == "term":
        need(a, 2, "ols term ONTOLOGY TERM_IRI_OR_ID")
        return Req(f"{base}/ontologies/{q(a[0])}/terms?obo_id={q(a[1])}")
    raise SystemExit(f"unknown ols operation '{op}' (search, term)")


def quickgo(op, a, o):
    base = "https://www.ebi.ac.uk/QuickGO/services"
    if op == "search":
        need(a, 1, "quickgo search 'TERM'")
        return Req(f"{base}/ontology/go/search?query={q(a[0])}&limit={o.limit}")
    if op == "annotations":
        need(a, 1, "quickgo annotations UNIPROT_ACC")
        url = f"{base}/annotation/search?geneProductId={q(a[0].upper())}&limit={o.limit}"
        return Req(url, table=lambda p: [
            {
                "go_id": r.get("goId"),
                "aspect": r.get("goAspect"),
                "evidence": r.get("goEvidence"),
                "reference": r.get("reference"),
            }
            for r in p.get("results", [])
        ])
    raise SystemExit(f"unknown quickgo operation '{op}' (search, annotations)")


def pride(op, a, o):
    base = "https://www.ebi.ac.uk/pride/ws/archive/v2"
    if op == "search":
        need(a, 1, "pride search 'KEYWORD'")
        return Req(f"{base}/search/projects?keyword={q(a[0])}&pageSize={o.limit}")
    if op == "get":
        need(a, 1, "pride get PXD_ACCESSION")
        return Req(f"{base}/projects/{q(a[0].upper())}")
    raise SystemExit(f"unknown pride operation '{op}' (search, get)")


def encode(op, a, o):
    if op == "search":
        need(a, 1, "encode search 'TERM'")
        url = (
            "https://www.encodeproject.org/search/?"
            f"searchTerm={q(a[0])}&format=json&limit={o.limit}"
        )
        return Req(url, headers={"Accept": "application/json"})
    if op == "get":
        need(a, 1, "encode get ACCESSION")
        return Req(
            f"https://www.encodeproject.org/{q(a[0])}/?format=json",
            headers={"Accept": "application/json"},
        )
    raise SystemExit(f"unknown encode operation '{op}' (search, get)")


def cellxgene(op, a, o):
    base = "https://api.cellxgene.cziscience.com/curation/v1"
    if op == "collections":
        return Req(f"{base}/collections", table=lambda p: [
            {"id": c.get("collection_id"), "name": c.get("name"), "doi": c.get("doi")}
            for c in (p or [])[: o.limit]
        ])
    if op == "get":
        need(a, 1, "cellxgene get COLLECTION_ID")
        return Req(f"{base}/collections/{q(a[0])}")
    raise SystemExit(f"unknown cellxgene operation '{op}' (collections, get)")


def datasets(op, a, o):
    base = "https://api.ncbi.nlm.nih.gov/datasets/v2alpha"
    if op == "gene":
        need(a, 1, "datasets gene SYMBOL [--taxon 9606]")
        taxon = o.taxon or "9606"
        return Req(f"{base}/gene/symbol/{q(a[0].upper())}/taxon/{q(taxon)}")
    if op == "genome":
        need(a, 1, "datasets genome ACCESSION")
        return Req(f"{base}/genome/accession/{q(a[0])}/dataset_report")
    raise SystemExit(f"unknown datasets operation '{op}' (gene, genome)")


REGISTRY = {
    "uniprot": (uniprot, "Protein sequence + function (UniProtKB)", 0.0),
    "pdb": (pdb, "Experimental structures (RCSB PDB)", 0.0),
    "alphafold": (alphafold, "Predicted structures (AlphaFold DB)", 0.0),
    "ncbi": (ncbi, "E-utilities across pubmed/gene/nuccore/protein/sra/gds/clinvar", 0.35),
    "pubmed": (pubmed, "PubMed shorthand over E-utilities", 0.35),
    "datasets": (datasets, "NCBI Datasets: gene and genome reports", 0.35),
    "ensembl": (ensembl, "Genes, transcripts, sequence, variation, orthologues", 0.1),
    "chembl": (chembl, "Bioactivity, compounds, targets (ChEMBL)", 0.1),
    "pubchem": (pubchem, "Compounds, properties, synonyms (PubChem PUG REST)", 0.25),
    "kegg": (kegg, "Pathways, genes, compounds (KEGG REST)", 0.35),
    "reactome": (reactome, "Pathways and UniProt-to-pathway mapping", 0.1),
    "string": (string_db, "Protein-protein interaction networks + enrichment", 0.25),
    "interpro": (interpro, "Domains, families, functional sites", 0.1),
    "gwas": (gwas, "GWAS Catalog associations by gene, variant, trait", 0.1),
    "opentargets": (opentargets, "Target-disease associations (GraphQL)", 0.1),
    "europepmc": (europepmc, "Literature search, citations, references", 0.1),
    "crossref": (crossref, "DOI metadata and bibliographic search", 0.1),
    "biorxiv": (biorxiv, "bioRxiv/medRxiv preprint metadata", 0.25),
    "hgnc": (hgnc, "Approved human gene symbols (HGNC)", 0.1),
    "mygene": (mygene, "Fast gene annotation lookup (mygene.info)", 0.1),
    "ols": (ols, "Ontology terms: EFO, GO, MONDO, UBERON, CL (OLS4)", 0.1),
    "quickgo": (quickgo, "GO terms and gene product annotations", 0.1),
    "pride": (pride, "Proteomics datasets (PRIDE Archive)", 0.1),
    "encode": (encode, "Functional genomics experiments (ENCODE)", 0.1),
    "cellxgene": (cellxgene, "Single-cell collections (CZ CELLxGENE Discover)", 0.1),
}


# --------------------------------------------------------------------------- transport


def cache_path(root: Path, req: Req) -> Path:
    return root / ".science" / "cache" / f"{req.key()}.json"


def fetch(req: Req, root: Path, use_cache: bool, quiet: bool) -> tuple[str | bytes, bool]:
    cached = cache_path(root, req)
    if use_cache and not req.binary and cached.exists():
        payload = json.loads(cached.read_text())
        if not quiet:
            print(f"# cached {payload['fetched_at']}  {req.url}", file=sys.stderr)
        return payload["body"], True

    request = urllib.request.Request(  # noqa: S310 - fixed https endpoints
        req.url,
        data=req.body.encode() if req.body else None,
        headers={"User-Agent": USER_AGENT, **req.headers},
        method=req.method,
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:  # noqa: S310
            raw = response.read()
            content_type = response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:800]
        raise SystemExit(f"HTTP {exc.code} from {req.url}\n{detail}") from None
    except urllib.error.URLError as exc:
        raise SystemExit(f"network error contacting {req.url}: {exc.reason}") from None

    if req.binary:
        return raw, False

    text = raw.decode(errors="replace")
    if use_cache:
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(
            json.dumps(
                {
                    "url": req.url,
                    "method": req.method,
                    "body": text,
                    "content_type": content_type,
                    "fetched_at": provenance.now(),
                },
                indent=2,
            )
        )
    return text, False


# --------------------------------------------------------------------------- output


def select_path(payload, expression: str):
    current = payload
    for part in expression.split("."):
        if part == "":
            continue
        if isinstance(current, list):
            if part.isdigit():
                current = current[int(part)]
            else:
                current = [item.get(part) if isinstance(item, dict) else None for item in current]
            continue
        if isinstance(current, dict):
            current = current.get(part)
            continue
        return None
    return current


def render(text: str, req: Req, opts) -> str:
    if opts.format == "raw":
        return text
    try:
        payload = json.loads(text)
    except ValueError:
        if opts.format == "tsv":
            raise SystemExit("response is not JSON; use --format raw") from None
        return text
    if opts.select:
        payload = select_path(payload, opts.select)
    if opts.format == "tsv":
        if req.table is None:
            if isinstance(payload, list) and payload and isinstance(payload[0], dict):
                return "\n".join(_tsv_lines(payload))
            raise SystemExit(
                "no table view for this operation; use --format json (optionally with --select)"
            )
        return "\n".join(_tsv_lines(req.table(payload)))
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _tsv_lines(rows: list[dict]) -> list[str]:
    if not rows:
        return ["(no rows)"]
    columns: list[str] = []
    for row in rows:
        for key in row:
            if key not in columns:
                columns.append(key)
    lines = ["\t".join(columns)]
    for row in rows:
        lines.append(
            "\t".join(
                "" if row.get(c) is None else str(row.get(c)).replace("\t", " ").replace("\n", " ")
                for c in columns
            )
        )
    return lines


def show_list() -> int:
    width = max(len(name) for name in REGISTRY)
    print("database".ljust(width), " description")
    print("-" * (width + 60))
    for name, (_, description, _) in sorted(REGISTRY.items()):
        print(f"{name.ljust(width)}  {description}")
    print("\ndbfetch.py help DB   for the operations of one database")
    return 0


def show_help(name: str) -> int:
    if name not in REGISTRY:
        print(f"unknown database '{name}'", file=sys.stderr)
        return 2
    handler, description, _ = REGISTRY[name]
    print(f"{name}: {description}\n")
    dummy = argparse.Namespace(limit=10, fmt=None, by=None, species=None, taxon=None)
    try:
        handler("__help__", [], dummy)
    except SystemExit as exc:
        message = str(exc)
        start = message.find("(")
        print("operations: " + (message[start:] if start >= 0 else message))
    print(f"\ndbfetch.py {name} OPERATION ARGS...   (an operation with wrong arity prints its usage)")
    return 0


# --------------------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="dbfetch.py list   for the database table",
    )
    parser.add_argument("db", help="database name, or 'list' / 'help'")
    parser.add_argument("op", nargs="?", help="operation")
    parser.add_argument("args", nargs="*", help="operation arguments")
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--format", choices=["json", "tsv", "raw"], default="json")
    parser.add_argument("--select", help="dotted path into the JSON response")
    parser.add_argument("--out", help="write the response to this file or directory")
    parser.add_argument("--fmt", help="operation-specific format (cif, pdb, fasta, abstract, ...)")
    parser.add_argument("--by", help="identifier namespace (name, cid, smiles, efo, go, ...)")
    parser.add_argument("--species", help="species name, e.g. homo_sapiens / 'Homo sapiens'")
    parser.add_argument("--taxon", help="NCBI taxon id, e.g. 9606")
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--project", help="project root for cache and ledger (default: cwd)")
    opts = parser.parse_args()

    if opts.db == "list":
        return show_list()
    if opts.db == "help":
        return show_help(opts.op) if opts.op else show_list()
    if opts.db not in REGISTRY:
        print(f"unknown database '{opts.db}' - try: dbfetch.py list", file=sys.stderr)
        return 2
    if not opts.op:
        return show_help(opts.db)

    root = Path(opts.project or Path.cwd()).resolve()
    handler, _, delay = REGISTRY[opts.db]
    req = handler(opts.op, opts.args, opts)
    if delay:
        time.sleep(delay)

    body, was_cached = fetch(req, root, use_cache=not opts.no_cache, quiet=opts.quiet)

    if isinstance(body, bytes):
        if not opts.out:
            print("this operation returns a file; pass --out FILE_OR_DIR", file=sys.stderr)
            return 2
        target = Path(opts.out)
        if target.is_dir():
            target = target / Path(urllib.parse.urlparse(req.url).path).name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        print(f"wrote {target} ({len(body)} bytes)")
    else:
        rendered = render(body, req, opts)
        if opts.out:
            target = Path(opts.out)
            if target.is_dir():
                target = target / f"{opts.db}_{opts.op}_{req.key()[:8]}.{opts.format}"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(rendered if rendered.endswith("\n") else rendered + "\n")
            print(f"wrote {target}")
        else:
            print(rendered)

    provenance.append_ledger(
        root,
        {
            "ts": provenance.now(),
            "type": "fetch",
            "db": opts.db,
            "op": opts.op,
            "args": opts.args,
            "url": req.url,
            "request_hash": req.key(),
            "cached": was_cached,
            "out": opts.out,
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
