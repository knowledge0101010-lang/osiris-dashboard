import { describe, it, expect } from 'vitest';
import {
  analyzeDevice,
  analyzeDeviceText,
  decodeModelHint,
  gradeFor,
  normaliseDate,
  parseBattery,
  parseDeviceInput,
  parseGetprop,
  parseKeyValue,
  parsePackages,
  redactIdentifiers,
} from './device-intel';

const NOW = new Date('2026-07-26T00:00:00Z');

/** A healthy, up-to-date handset. */
const CLEAN_GETPROP = `
[ro.product.manufacturer]: [samsung]
[ro.product.brand]: [samsung]
[ro.product.model]: [SM-S928N]
[ro.product.device]: [e3q]
[ro.build.version.release]: [15]
[ro.build.version.sdk]: [35]
[ro.build.version.security_patch]: [2026-07-01]
[ro.build.type]: [user]
[ro.build.tags]: [release-keys]
[ro.boot.flash.locked]: [1]
[ro.boot.verifiedbootstate]: [green]
[ro.crypto.state]: [encrypted]
[ro.boot.selinux]: [enforcing]
[ro.debuggable]: [0]
[ro.secure]: [1]
`.trim();

/** An old, unlocked, rooted handset with network ADB open. */
const COMPROMISED_GETPROP = `
[ro.product.manufacturer]: [Xiaomi]
[ro.product.model]: [Redmi Note 8]
[ro.build.version.release]: [10]
[ro.build.version.sdk]: [29]
[ro.build.version.security_patch]: [2021-03-01]
[ro.build.type]: [userdebug]
[ro.build.tags]: [test-keys]
[ro.boot.flash.locked]: [0]
[ro.boot.verifiedbootstate]: [orange]
[ro.crypto.state]: [unencrypted]
[ro.boot.selinux]: [permissive]
[ro.debuggable]: [1]
[ro.secure]: [0]
[service.adb.tcp.port]: [5555]
`.trim();

describe('parseGetprop', () => {
  it('extracts bracketed key/value pairs', () => {
    const props = parseGetprop(CLEAN_GETPROP);
    expect(props['ro.product.model']).toBe('SM-S928N');
    expect(props['ro.build.version.sdk']).toBe('35');
  });

  it('keeps empty values without crashing', () => {
    expect(parseGetprop('[ro.empty]: []')).toEqual({ 'ro.empty': '' });
  });

  it('ignores non-getprop noise', () => {
    expect(parseGetprop('just a sentence\n\n# comment')).toEqual({});
  });
});

describe('parseKeyValue', () => {
  it('reads a pasted Korean Settings screen', () => {
    const kv = parseKeyValue('모델 번호: SM-S928N\nAndroid 버전 = 15\n\n빌드번호: AP3A.240905.015');
    expect(kv['모델 번호']).toBe('SM-S928N');
    expect(kv['Android 버전']).toBe('15');
    expect(kv['빌드번호']).toBe('AP3A.240905.015');
  });

  it('skips blank lines and comments', () => {
    expect(parseKeyValue('# note: ignored\n\n')).toEqual({});
  });
});

describe('parsePackages', () => {
  it('strips the package: prefix and dedupes', () => {
    const list = parsePackages(
      'package:com.kakao.talk\npackage:com.nhn.android.search\npackage:com.kakao.talk',
    );
    expect(list).toEqual(['com.kakao.talk', 'com.nhn.android.search']);
  });

  it('handles the -f form that prefixes the apk path', () => {
    expect(parsePackages('package:/data/app/base.apk=com.example.app')).toEqual(['com.example.app']);
  });
});

describe('parseBattery', () => {
  it('decodes dumpsys health/status codes and tenths-of-degree temperature', () => {
    const b = parseBattery(`
Current Battery Service state:
  level: 84
  scale: 100
  voltage: 4201
  temperature: 312
  health: 2
  status: 3
`);
    expect(b.level).toBe(84);
    expect(b.health).toBe('GOOD');
    expect(b.status).toBe('DISCHARGING');
    expect(b.temperatureC).toBe(31.2);
    expect(b.voltageMv).toBe(4201);
  });

  it('returns nulls for an empty dump', () => {
    expect(parseBattery('')).toEqual({
      level: null,
      health: null,
      status: null,
      temperatureC: null,
      voltageMv: null,
      cycleCount: null,
    });
  });
});

describe('normaliseDate', () => {
  it('normalises ISO, dotted and Korean dates', () => {
    expect(normaliseDate('2025-11-01')).toBe('2025-11-01');
    expect(normaliseDate('2025.11.1')).toBe('2025-11-01');
    expect(normaliseDate('2025년 11월 1일')).toBe('2025-11-01');
  });

  it('defaults a missing day to the first of the month', () => {
    expect(normaliseDate('2025-11')).toBe('2025-11-01');
  });

  it('returns null for junk', () => {
    expect(normaliseDate('')).toBeNull();
    expect(normaliseDate(undefined)).toBeNull();
    expect(normaliseDate('not a date')).toBeNull();
  });
});

describe('decodeModelHint', () => {
  it('recognises the Samsung Korean SKU suffix', () => {
    expect(decodeModelHint('SM-S928N')).toContain('Korea');
  });

  it('recognises Apple internal identifiers', () => {
    expect(decodeModelHint('iPhone16,2')).toContain('Apple');
  });

  it('returns null for unknown shapes', () => {
    expect(decodeModelHint('Redmi Note 8')).toBeNull();
    expect(decodeModelHint(null)).toBeNull();
  });
});

describe('redactIdentifiers', () => {
  it('removes an IMEI by value shape', () => {
    const { text, found } = redactIdentifiers('some line 356938035643809 here');
    expect(text).not.toContain('356938035643809');
    expect(found).toContain('IMEI/MEID');
  });

  it('removes a serial by label even though the value looks harmless', () => {
    const { text, found } = redactIdentifiers('[ro.serialno]: [R3CN90ABCDE]');
    expect(text).not.toContain('R3CN90ABCDE');
    expect(found).toContain('Serial');
  });

  it('removes MAC addresses, phone numbers and emails', () => {
    const { text, found } = redactIdentifiers('mac 3c:5a:b4:01:02:03 tel +821012345678 me@example.com');
    expect(text).not.toMatch(/3c:5a/i);
    expect(text).not.toContain('+821012345678');
    expect(text).not.toContain('me@example.com');
    expect(found).toEqual(expect.arrayContaining(['MAC', 'E.164', 'Email']));
  });

  it('leaves version strings intact', () => {
    const { text, found } = redactIdentifiers('[ro.build.version.release]: [15]\nkernel: 6.1.75-android14-11');
    expect(text).toContain('6.1.75-android14-11');
    expect(text).toContain('[15]');
    expect(found).toEqual([]);
  });
});

describe('parseDeviceInput', () => {
  it('builds a profile from getprop output', () => {
    const p = parseDeviceInput(CLEAN_GETPROP);
    expect(p.platform).toBe('android');
    expect(p.manufacturer).toBe('samsung');
    expect(p.model).toBe('SM-S928N');
    expect(p.sdkInt).toBe(35);
    expect(p.securityPatch).toBe('2026-07-01');
    expect(p.bootloaderLocked).toBe(true);
    expect(p.debuggable).toBe(false);
    expect(p.secureProp).toBe(true);
  });

  it('folds Korean Settings labels onto the equivalent properties', () => {
    const p = parseDeviceInput(
      ['모델 번호: SM-S928N', 'Android 버전: 15', '보안 업데이트: 2026년 7월 1일', '커널 버전: 6.1.75'].join('\n'),
    );
    expect(p.model).toBe('SM-S928N');
    expect(p.release).toBe('15');
    expect(p.securityPatch).toBe('2026-07-01');
    expect(p.kernel).toBe('6.1.75');
  });

  it('accepts getprop, battery and package lists in one blob', () => {
    const p = parseDeviceInput(
      `${CLEAN_GETPROP}\n  level: 84\n  health: 2\n  temperature: 312\npackage:com.kakao.talk\n`,
    );
    expect(p.model).toBe('SM-S928N');
    expect(p.battery.level).toBe(84);
    expect(p.battery.health).toBe('GOOD');
    expect(p.thirdPartyPackages).toEqual(['com.kakao.talk']);
  });

  it('records which identifier kinds it stripped', () => {
    const p = parseDeviceInput(`${CLEAN_GETPROP}\n[ro.serialno]: [R3CN90ABCDE]`);
    expect(p.redacted).toContain('Serial');
  });

  it('derives bootloader state from verifiedbootstate when flash.locked is absent', () => {
    expect(parseDeviceInput('[ro.boot.verifiedbootstate]: [green]').bootloaderLocked).toBe(true);
    expect(parseDeviceInput('[ro.boot.verifiedbootstate]: [orange]').bootloaderLocked).toBe(false);
  });

  it('reads USB debugging from either the setting or the usb config', () => {
    expect(parseDeviceInput('adb_enabled: 1').adbEnabled).toBe(true);
    expect(parseDeviceInput('adb_enabled: 0').adbEnabled).toBe(false);
    expect(parseDeviceInput('[persist.sys.usb.config]: [mtp,adb]').adbEnabled).toBe(true);
    expect(parseDeviceInput('[persist.sys.usb.config]: [mtp]').adbEnabled).toBe(false);
    expect(parseDeviceInput(CLEAN_GETPROP).adbEnabled).toBeNull();
  });

  it('returns an empty profile rather than throwing on garbage', () => {
    const p = parseDeviceInput('아무 의미 없는 문장입니다');
    expect(p.platform).toBe('unknown');
    expect(p.model).toBeNull();
    expect(p.thirdPartyPackages).toEqual([]);
  });
});

describe('analyzeDevice', () => {
  it('grades a current, locked, encrypted device as clean', () => {
    const report = analyzeDeviceText(CLEAN_GETPROP, NOW);
    const actionable = report.findings.filter((f) => f.severity !== 'INFO');
    expect(actionable).toEqual([]);
    expect(report.riskScore).toBe(0);
    expect(report.grade).toBe('A');
    expect(report.findings.some((f) => f.id === 'patch-current')).toBe(true);
  });

  it('flags every integrity problem on a compromised device', () => {
    const report = analyzeDeviceText(COMPROMISED_GETPROP, NOW);
    const ids = report.findings.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'patch-abandoned',
        'android-eol',
        'bootloader-unlocked',
        'verified-boot-custom',
        'build-test-keys',
        'build-type-debug',
        'prop-debuggable',
        'prop-insecure',
        'selinux-permissive',
        'not-encrypted',
        'adb-over-network',
      ]),
    );
    expect(report.riskScore).toBe(100);
    expect(report.grade).toBe('F');
  });

  it('sorts findings most severe first', () => {
    const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
    const severities = analyzeDeviceText(COMPROMISED_GETPROP, NOW).findings.map((f) =>
      order.indexOf(f.severity),
    );
    expect([...severities].sort((a, b) => a - b)).toEqual(severities);
  });

  it('escalates patch staleness by age', () => {
    const at = (patch: string) =>
      analyzeDeviceText(`[ro.build.version.security_patch]: [${patch}]`, NOW).findings[0];
    expect(at('2026-07-01').id).toBe('patch-current');
    expect(at('2026-06-01').id).toBe('patch-slightly-behind');
    expect(at('2026-03-01').id).toBe('patch-stale');
    expect(at('2025-11-01').id).toBe('patch-stale-severe');
    expect(at('2024-01-01').id).toBe('patch-abandoned');
  });

  it('reports vendor patch drift only when it is large', () => {
    const drifted = analyzeDeviceText(
      '[ro.build.version.security_patch]: [2026-07-01]\n[ro.vendor.build.security_patch]: [2025-09-01]',
      NOW,
    );
    expect(drifted.findings.some((f) => f.id === 'vendor-patch-drift')).toBe(true);

    const aligned = analyzeDeviceText(
      '[ro.build.version.security_patch]: [2026-07-01]\n[ro.vendor.build.security_patch]: [2026-06-01]',
      NOW,
    );
    expect(aligned.findings.some((f) => f.id === 'vendor-patch-drift')).toBe(false);
  });

  it('raises CRITICAL for a red verified boot state', () => {
    const report = analyzeDeviceText('[ro.boot.verifiedbootstate]: [red]', NOW);
    const finding = report.findings.find((f) => f.id === 'verified-boot-red');
    expect(finding?.severity).toBe('CRITICAL');
  });

  it('flags a root manager in the installed package list', () => {
    const report = analyzeDeviceText(`${CLEAN_GETPROP}\npackage:com.topjohnwu.magisk`, NOW);
    const finding = report.findings.find((f) => f.id === 'package-watch:com.topjohnwu.magisk');
    expect(finding?.severity).toBe('CRITICAL');
  });

  it('does not flag ordinary apps', () => {
    const report = analyzeDeviceText(`${CLEAN_GETPROP}\npackage:com.kakao.talk`, NOW);
    expect(report.findings.some((f) => f.id.startsWith('package-watch:'))).toBe(false);
  });

  it('flags battery overheating and reported ill health', () => {
    const report = analyzeDeviceText(`${CLEAN_GETPROP}\n  level: 40\n  health: 3\n  temperature: 491`, NOW);
    expect(report.findings.find((f) => f.id === 'battery-health')?.severity).toBe('MEDIUM');
    expect(report.findings.find((f) => f.id === 'battery-temp')?.severity).toBe('HIGH');
  });

  it('lists the inputs it did not receive', () => {
    const report = analyzeDeviceText('[ro.product.model]: [SM-S928N]', NOW);
    expect(report.missing).toEqual(
      expect.arrayContaining([
        'security patch level',
        'Android SDK level',
        'installed package list (`pm list packages -3`)',
        'battery state (`dumpsys battery`)',
      ]),
    );
  });

  it('never echoes a redacted identifier back into the report', () => {
    const report = analyzeDeviceText(
      `${CLEAN_GETPROP}\n[ro.serialno]: [R3CN90ABCDE]\nIMEI: 356938035643809`,
      NOW,
    );
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('R3CN90ABCDE');
    expect(serialised).not.toContain('356938035643809');
  });

  it('produces a summary naming the device and counting actionable findings', () => {
    expect(analyzeDeviceText(CLEAN_GETPROP, NOW).summary).toContain('SM-S928N');
    expect(analyzeDeviceText(COMPROMISED_GETPROP, NOW).summary).toMatch(/CRITICAL \d+/);
  });

  it('is deterministic for a given clock', () => {
    const a = analyzeDeviceText(COMPROMISED_GETPROP, NOW);
    const b = analyzeDevice(parseDeviceInput(COMPROMISED_GETPROP), NOW);
    expect(a).toEqual(b);
  });
});

describe('gradeFor', () => {
  it('maps score bands to letters', () => {
    expect(gradeFor(0)).toBe('A');
    expect(gradeFor(7)).toBe('A');
    expect(gradeFor(8)).toBe('B');
    expect(gradeFor(20)).toBe('C');
    expect(gradeFor(40)).toBe('D');
    expect(gradeFor(100)).toBe('F');
  });
});
