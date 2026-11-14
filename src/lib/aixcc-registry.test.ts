import { describe, it, expect } from 'vitest';
import {
  AIXCC_REGISTRY,
  CHALLENGE_ENTRIES,
  CRS_ENTRIES,
  INFRA_ENTRIES,
  allRepos,
  registryStats,
  releaseUrl,
  repoUrl,
} from './aixcc-registry';

describe('registry shape', () => {
  it('covers all seven finalist CRSs', () => {
    expect(CRS_ENTRIES).toHaveLength(7);
  });

  it('gives every entry a unique id', () => {
    const ids = AIXCC_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every entry at least one release', () => {
    for (const entry of AIXCC_REGISTRY) {
      expect(entry.releases.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('uses owner/name slugs throughout', () => {
    for (const repo of allRepos()) {
      expect(repo, repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
  });

  it('releases every CRS for both competition rounds', () => {
    for (const entry of CRS_ENTRIES) {
      const rounds = entry.releases.map((r) => r.round).sort();
      expect(rounds, entry.id).toEqual(['final', 'semifinal']);
    }
  });

  it('points every challenge entry at its archive write-up', () => {
    for (const entry of CHALLENGE_ENTRIES) {
      expect(entry.challengePath, entry.id).toMatch(
        /^https:\/\/archive\.aicyberchallenge\.com\/challenges\/[\w-]+\/$/,
      );
    }
  });

  it('awards the three podium placements exactly once each', () => {
    const placements = CRS_ENTRIES.map((e) => e.placement).filter((p) => p !== undefined);
    expect(placements.sort()).toEqual([1, 2, 3]);
  });
});

describe('url helpers', () => {
  it('builds a repo url from a slug', () => {
    expect(repoUrl('trailofbits/afc-buttercup')).toBe('https://github.com/trailofbits/afc-buttercup');
  });

  it('links a tagged release to its tag page', () => {
    expect(releaseUrl({ round: 'final', repo: 'shellphish/artiphishell', tag: 'Finals' })).toBe(
      'https://github.com/shellphish/artiphishell/releases/tag/Finals',
    );
  });

  it('links an untagged release to the repo root', () => {
    expect(releaseUrl({ round: 'final', repo: 'siftech/afc-crs-lacrosse' })).toBe(
      'https://github.com/siftech/afc-crs-lacrosse',
    );
  });
});

describe('allRepos', () => {
  it('deduplicates repos shared across releases', () => {
    const artiphishell = allRepos(CRS_ENTRIES).filter((r) => r === 'shellphish/artiphishell');
    expect(artiphishell).toHaveLength(1);
  });

  it('returns a sorted list', () => {
    const repos = allRepos();
    expect(repos).toEqual([...repos].sort());
  });
});

describe('registryStats', () => {
  it('counts entries by kind', () => {
    const stats = registryStats();
    expect(stats.crs).toBe(CRS_ENTRIES.length);
    expect(stats.infra).toBe(INFRA_ENTRIES.length);
    expect(stats.challenges).toBe(CHALLENGE_ENTRIES.length);
    expect(stats.entries).toBe(AIXCC_REGISTRY.length);
  });

  it('counts fewer repos than releases, since Artiphishell ships two tags of one repo', () => {
    const releases = AIXCC_REGISTRY.reduce((n, e) => n + e.releases.length, 0);
    expect(registryStats().repos).toBeLessThan(releases);
  });

  it('totals challenge variants and vulns across target projects', () => {
    const stats = registryStats();
    expect(stats.challengeVariants).toBe(
      CHALLENGE_ENTRIES.reduce((n, e) => n + (e.challengeCount ?? 0), 0),
    );
    expect(stats.vulnerabilities).toBeGreaterThan(0);
  });
});

// Live integration test — opt in with RUN_LIVE_TESTS=1 (resolves every real git remote).
const liveIt = process.env.RUN_LIVE_TESTS === '1' ? it : it.skip;

describe('live archive verification', () => {
  liveIt('resolves every registered repo on GitHub', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    const results = await Promise.all(
      allRepos().map(async (repo) => {
        try {
          const { stdout } = await run('git', ['ls-remote', `${repoUrl(repo)}.git`, 'HEAD'], {
            timeout: 60_000,
          });
          return { repo, ok: stdout.trim().length > 0 };
        } catch {
          return { repo, ok: false };
        }
      }),
    );

    expect(results.filter((r) => !r.ok).map((r) => r.repo)).toEqual([]);
  }, 300_000);
});
