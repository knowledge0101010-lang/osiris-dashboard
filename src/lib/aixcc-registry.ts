/**
 * OSIRIS — AIxCC Open Source Archive Registry
 *
 * A machine-readable index of every code repository published through the DARPA
 * AI Cyber Challenge competition archive (https://archive.aicyberchallenge.com).
 *
 * The archive publishes three classes of code:
 *   1. `crs`         — the seven finalist Cyber Reasoning Systems, released per round.
 *   2. `infra`       — the competition infrastructure the CRSs ran against.
 *   3. `challenge`   — the OSS projects used as competition targets, with injected vulns.
 *
 * Every `repo` below was resolved against the live git remote when this file was
 * written. `src/lib/aixcc-registry.test.ts` re-verifies them under RUN_LIVE_TESTS=1.
 */

/** Competition round a release belongs to. */
export type AixccRound = 'semifinal' | 'final';

/** What kind of code a registry entry points at. */
export type AixccKind = 'crs' | 'infra' | 'challenge';

export interface AixccRelease {
  round: AixccRound;
  /** `owner/name` as hosted on GitHub. */
  repo: string;
  /** Release tag, when the team published one instead of a dedicated repo. */
  tag?: string;
}

export interface AixccEntry {
  id: string;
  kind: AixccKind;
  name: string;
  summary: string;
  releases: AixccRelease[];
  /** Finalist team that authored the code — CRS entries only. */
  team?: string;
  /** Final-round placement, where one was awarded. */
  placement?: number;
  /** Archive path for the project's challenge write-ups — challenge entries only. */
  challengePath?: string;
  /** Number of distinct challenge variants built from the project. */
  challengeCount?: number;
  /** Number of documented vulnerabilities across those variants. */
  vulnCount?: number;
}

export const AIXCC_ARCHIVE_URL = 'https://archive.aicyberchallenge.com';

/** The seven finalist Cyber Reasoning Systems, all released open source. */
export const CRS_ENTRIES: AixccEntry[] = [
  {
    id: 'crs-atlantis',
    kind: 'crs',
    name: 'Atlantis',
    team: 'Team Atlanta',
    placement: 1,
    summary: 'Winning CRS of the AIxCC final competition.',
    releases: [
      { round: 'semifinal', repo: 'Team-Atlanta/aixcc-asc-atlantis' },
      { round: 'final', repo: 'Team-Atlanta/aixcc-afc-atlantis' },
    ],
  },
  {
    id: 'crs-buttercup',
    kind: 'crs',
    name: 'Buttercup',
    team: 'Trail of Bits',
    placement: 2,
    summary: "Trail of Bits' CRS, second place in the final competition.",
    releases: [
      { round: 'semifinal', repo: 'trailofbits/asc-buttercup' },
      { round: 'final', repo: 'trailofbits/afc-buttercup' },
    ],
  },
  {
    id: 'crs-roboduck',
    kind: 'crs',
    name: 'RoboDuck',
    team: 'Theori',
    placement: 3,
    summary: "Theori's CRS, third place in the final competition.",
    releases: [
      { round: 'semifinal', repo: 'theori-io/aixcc-asc-archive' },
      { round: 'final', repo: 'theori-io/aixcc-afc-archive' },
    ],
  },
  {
    id: 'crs-artiphishell',
    kind: 'crs',
    name: 'Artiphishell',
    team: 'Shellphish',
    summary: "Shellphish's CRS, published as tagged releases on a single repo.",
    releases: [
      { round: 'semifinal', repo: 'shellphish/artiphishell', tag: 'Semi-Finals' },
      { round: 'final', repo: 'shellphish/artiphishell', tag: 'Finals' },
    ],
  },
  {
    id: 'crs-fuzzing-brain',
    kind: 'crs',
    name: 'Fuzzing Brain',
    team: 'All You Need Is A Fuzzing Brain',
    summary: 'CRS from the Texas A&M-led academic team.',
    releases: [
      { round: 'semifinal', repo: 'o2lab/asc-crs-all-you-need-is-a-fuzzing-brain' },
      { round: 'final', repo: 'o2lab/afc-crs-all-you-need-is-a-fuzzing-brain' },
    ],
  },
  {
    id: 'crs-bug-buster',
    kind: 'crs',
    name: 'Bug Buster',
    team: '42 b3yond 6ug',
    summary: 'CRS from the five-university team led by Northwestern.',
    releases: [
      { round: 'semifinal', repo: '42-b3yond-6ug/42-b3yond-6ug-asc' },
      { round: 'final', repo: '42-b3yond-6ug/42-b3yond-6ug-crs' },
    ],
  },
  {
    id: 'crs-lacrosse',
    kind: 'crs',
    name: 'Lacrosse',
    team: 'Lacrosse',
    summary: "SIFT's CRS, descended from their Cyber Grand Challenge-era system.",
    releases: [
      { round: 'semifinal', repo: 'siftech/asc-crs-lacrosse' },
      { round: 'final', repo: 'siftech/afc-crs-lacrosse' },
    ],
  },
];

/** Competition infrastructure and tooling published alongside the CRSs. */
export const INFRA_ENTRIES: AixccEntry[] = [
  {
    id: 'infra-competition-api',
    kind: 'infra',
    name: 'Competition API',
    summary: 'The Competition API implementation used for the final round.',
    releases: [{ round: 'final', repo: 'AIxCyberChallenge/competition-api' }],
  },
  {
    id: 'infra-example-crs',
    kind: 'infra',
    name: 'Example CRS Architecture',
    summary: 'Reference infrastructure and API specs for building a compliant CRS.',
    releases: [{ round: 'final', repo: 'AIxCyberChallenge/example-crs-architecture' }],
  },
  {
    id: 'infra-sherpa',
    kind: 'infra',
    name: 'SHERPA',
    summary:
      'Security Harness Engineering for Robust Program Analysis — generates fuzzing harnesses for attacker-controlled entrypoints.',
    releases: [{ round: 'final', repo: 'AIxCyberChallenge/sherpa' }],
  },
  {
    id: 'infra-scoring-pipeline',
    kind: 'infra',
    name: 'Finals Scoring Pipeline',
    summary: 'Audit-log analysis and scoring computation behind the final rankings.',
    releases: [{ round: 'final', repo: 'AIxCyberChallenge/scoring-pipeline' }],
  },
  {
    id: 'infra-archive-site',
    kind: 'infra',
    name: 'Competition Archive Site',
    summary: 'Source of the archive website itself, and the canonical index of everything below.',
    releases: [{ round: 'final', repo: 'AIxCyberChallenge/archive' }],
  },
];

/** Open source projects used as final-round competition targets. */
export const CHALLENGE_ENTRIES: AixccEntry[] = [
  ['challenge-commons-compress', 'Apache Commons Compress', 'afc-commons-compress', 'apache-commons-compress', 5, 5],
  ['challenge-poi', 'Apache POI', 'afc-poi', 'apache-poi', 2, 7],
  ['challenge-hertzbeat', 'Apache HertzBeat', 'afc-hertzbeat', 'hertzbeat', 1, 0],
  ['challenge-log4j2', 'Apache Log4j', 'afc-logging-log4j2', 'log4j2', 1, 1],
  ['challenge-pdfbox', 'Apache PDFBox', 'afc-pdfbox', 'pdfbox', 2, 9],
  ['challenge-tika', 'Apache Tika', 'afc-tika', 'tika', 1, 1],
  ['challenge-curl', 'cURL', 'afc-curl', 'curl', 5, 6],
  ['challenge-dav1d', 'dav1d', 'afc-dav1d', 'dav1d', 1, 1],
  ['challenge-dcm4che', 'dcm4che', 'afc-dcm4che', 'dcm4che', 1, 0],
  ['challenge-dicoogle', 'Dicoogle', 'afc-dicoogle', 'dicoogle', 1, 0],
  ['challenge-freerdp', 'FreeRDP', 'afc-freerdp', 'freerdp', 3, 2],
  [
    'challenge-healthcare-data-harmonization',
    'Whistle Data Transformation Language',
    'afc-healthcare-data-harmonization',
    'healthcare-data-harmonization',
    1,
    0,
  ],
  ['challenge-jsoup', 'jsoup', 'afc-jsoup', 'jsoup', 1, 0],
  ['challenge-libavif', 'libavif', 'afc-libavif', 'libavif', 2, 1],
  ['challenge-libexif', 'libexif', 'afc-libexif', 'libexif', 2, 2],
  ['challenge-libxml2', 'libxml2', 'afc-libxml2', 'libxml2', 1, 1],
  ['challenge-lcms', 'Little CMS', 'afc-little-cms', 'lcms', 2, 2],
  ['challenge-mongoose', 'Mongoose', 'afc-mongoose', 'mongoose', 4, 3],
  ['challenge-ndpi', 'nDPI', 'afc-ndpi', 'ndpi', 1, 0],
  ['challenge-openssl', 'OpenSSL', 'afc-openssl', 'openssl', 1, 0],
  ['challenge-shadowsocks', 'Shadowsocks-libev', 'afc-shadowsocks-libev', 'shadowsocks', 1, 5],
  ['challenge-systemd', 'systemd', 'afc-systemd', 'systemd', 1, 4],
  ['challenge-wireshark', 'Wireshark', 'afc-wireshark', 'wireshark', 7, 12],
  ['challenge-xz', 'XZ Utils', 'afc-xz', 'xz', 1, 1],
].map(([id, name, repoName, path, challengeCount, vulnCount]) => ({
  id: id as string,
  kind: 'challenge' as const,
  name: name as string,
  summary: `Competition target built from ${name}.`,
  releases: [{ round: 'final' as const, repo: `AIxCyberChallenge/${repoName}` }],
  challengePath: `${AIXCC_ARCHIVE_URL}/challenges/${path}/`,
  challengeCount: challengeCount as number,
  vulnCount: vulnCount as number,
}));

/** Every entry in the archive, in presentation order. */
export const AIXCC_REGISTRY: AixccEntry[] = [
  ...CRS_ENTRIES,
  ...INFRA_ENTRIES,
  ...CHALLENGE_ENTRIES,
];

/** Clone URL for a `owner/name` repo slug. */
export function repoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

/** Web URL for a release — the tag page when tagged, otherwise the repo root. */
export function releaseUrl(release: AixccRelease): string {
  return release.tag
    ? `${repoUrl(release.repo)}/releases/tag/${release.tag}`
    : repoUrl(release.repo);
}

/** Every distinct repo slug in the registry, deduplicated and sorted. */
export function allRepos(registry: AixccEntry[] = AIXCC_REGISTRY): string[] {
  const seen = new Set<string>();
  for (const entry of registry) {
    for (const release of entry.releases) seen.add(release.repo);
  }
  return [...seen].sort();
}

export interface AixccRegistryStats {
  entries: number;
  repos: number;
  crs: number;
  infra: number;
  challenges: number;
  /** Distinct challenge variants across all target projects. */
  challengeVariants: number;
  /** Documented vulnerabilities across all challenge variants. */
  vulnerabilities: number;
}

export function registryStats(registry: AixccEntry[] = AIXCC_REGISTRY): AixccRegistryStats {
  const byKind = (kind: AixccKind) => registry.filter((e) => e.kind === kind);
  const sum = (pick: (e: AixccEntry) => number | undefined) =>
    registry.reduce((total, e) => total + (pick(e) ?? 0), 0);

  return {
    entries: registry.length,
    repos: allRepos(registry).length,
    crs: byKind('crs').length,
    infra: byKind('infra').length,
    challenges: byKind('challenge').length,
    challengeVariants: sum((e) => e.challengeCount),
    vulnerabilities: sum((e) => e.vulnCount),
  };
}
