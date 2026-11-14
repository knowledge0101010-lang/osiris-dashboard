/**
 * Device Intel — offline smartphone posture analysis.
 *
 * Takes whatever a user can realistically get off a phone (a pasted
 * "About phone" screen, an `adb shell getprop` dump, `dumpsys battery`,
 * `pm list packages -3`) and turns it into a normalised profile plus a
 * ranked list of security / privacy / lifecycle findings.
 *
 * Everything here is pure and offline: no network calls, no third-party
 * lookups. Hardware identifiers (IMEI, serial, ICCID, MAC, phone number)
 * are detected and redacted before anything is echoed back.
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  CRITICAL: 40,
  HIGH: 20,
  MEDIUM: 10,
  LOW: 4,
  INFO: 0,
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  CRITICAL: '#FF1744',
  HIGH: '#FF3D3D',
  MEDIUM: '#FF9500',
  LOW: '#FFD700',
  INFO: '#00BCD4',
};

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  recommendation: string;
  /** Property / label the finding was derived from, for traceability. */
  evidence?: string;
}

export interface BatteryInfo {
  level: number | null;
  health: string | null;
  status: string | null;
  temperatureC: number | null;
  voltageMv: number | null;
  cycleCount: number | null;
}

export interface DeviceProfile {
  platform: 'android' | 'ios' | 'unknown';
  manufacturer: string | null;
  brand: string | null;
  model: string | null;
  /** Heuristic decode of the model code (e.g. Samsung SKU region suffix). */
  modelHint: string | null;
  device: string | null;
  hardware: string | null;
  /** Marketing version, e.g. "15" on Android or "18.2" on iOS. */
  release: string | null;
  sdkInt: number | null;
  buildId: string | null;
  buildFingerprint: string | null;
  buildType: string | null;
  buildTags: string | null;
  securityPatch: string | null;
  vendorSecurityPatch: string | null;
  kernel: string | null;
  baseband: string | null;
  bootloaderLocked: boolean | null;
  verifiedBootState: string | null;
  encryptionState: string | null;
  selinux: string | null;
  debuggable: boolean | null;
  secureProp: boolean | null;
  adbEnabled: boolean | null;
  adbTcpPort: string | null;
  developerOptions: boolean | null;
  unknownSources: boolean | null;
  carrier: string | null;
  locale: string | null;
  timezone: string | null;
  battery: BatteryInfo;
  thirdPartyPackages: string[];
  /** Identifier kinds seen in the input and stripped (never the values). */
  redacted: string[];
  /** Keys parsed but not mapped onto the profile — useful for debugging. */
  unmapped: Record<string, string>;
}

export interface DeviceIntelReport {
  profile: DeviceProfile;
  findings: Finding[];
  /** 0 (clean) .. 100 (severely exposed). */
  riskScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  summary: string;
  /** Inputs the report would have used but did not receive. */
  missing: string[];
  generatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

/**
 * Value-shape rules. Deliberately conservative: an over-eager pattern (an
 * IPv4-looking rule, say) would shred legitimate version strings, so anything
 * ambiguous is handled by the label rules below instead.
 */
const REDACTION_RULES: { kind: string; re: RegExp }[] = [
  { kind: 'ICCID', re: /\b89\d{17,18}\b/g },
  { kind: 'IMEI/MEID', re: /\b\d{15,17}\b/g },
  { kind: 'MAC', re: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g },
  { kind: 'E.164', re: /\+\d{9,15}\b/g },
  { kind: 'Email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
];

/** Labels whose *value* is an identifier regardless of its shape. */
const IDENTIFIER_LABELS: { kind: string; re: RegExp }[] = [
  { kind: 'Serial', re: /^(?:ro\.(?:serialno|boot\.serialno)|serial(?:\s*(?:no|number))?|일련\s*번호|시리얼(?:\s*번호)?)$/i },
  { kind: 'IMEI/MEID', re: /^(?:imei\s*\d?|meid|eid)$/i },
  { kind: 'SIM identifier', re: /^(?:iccid|imsi|sim\s*(?:일련\s*번호|serial))$/i },
  { kind: 'Phone number', re: /^(?:전화\s*번호|내\s*전화\s*번호|phone\s*number|msisdn)$/i },
  { kind: 'MAC', re: /^(?:(?:wi-?fi|와이파이|bluetooth|블루투스)\s*(?:mac\s*)?주소|(?:wi-?fi|bluetooth)\s*mac(?:\s*address)?)$/i },
  { kind: 'IP address', re: /^(?:ip\s*(?:주소|address)|ipv[46]\s*(?:주소|address))$/i },
  { kind: 'Account', re: /^(?:사용자\s*이름|계정|account|google\s*account)$/i },
];

/**
 * Strip anything that identifies the handset or its owner: first by label
 * (the value's shape is irrelevant when the key says "IMEI"), then by value
 * shape for identifiers that appear inline.
 *
 * Returns the scrubbed text plus the kinds of identifier that were removed —
 * never the values themselves.
 */
export function redactIdentifiers(text: string): { text: string; found: string[] } {
  const found = new Set<string>();

  const byLabel = text
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*)\[?([^:=[\]]{1,60}?)\]?\s*[:=]\s*(.+)$/);
      if (!m) return line;
      const label = m[2].trim();
      const rule = IDENTIFIER_LABELS.find((r) => r.re.test(label));
      if (!rule) return line;
      found.add(rule.kind);
      return `${m[1]}${label}: REDACTED`;
    })
    .join('\n');

  let out = byLabel;
  for (const { kind, re } of REDACTION_RULES) {
    out = out.replace(re, () => {
      found.add(kind);
      // No brackets in the token: it must not confuse the getprop parser.
      return `REDACTED_${kind.replace(/[^A-Z]/gi, '_').toUpperCase()}`;
    });
  }

  return { text: out, found: [...found].sort() };
}

/* ------------------------------------------------------------------ *
 * Parsers
 * ------------------------------------------------------------------ */

/** `[ro.product.model]: [SM-S928N]` → `{ 'ro.product.model': 'SM-S928N' }` */
export function parseGetprop(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\[([^\]]+)\]:\s*\[([^\]]*)\]\s*$/;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/**
 * Free-form `key: value` / `key=value` pairs — covers a pasted Settings
 * screen (Korean or English) as well as raw `getprop`-style key=value output.
 */
export function parseKeyValue(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([^:=]{1,60}?)\s*[:=]\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().replace(/^\[|\]$/g, '');
    const value = m[2].trim().replace(/^\[|\]$/g, '');
    if (!key || !value) continue;
    // Last value wins, except never overwrite a non-empty with an empty one.
    out[key] = value;
  }
  return out;
}

/** `adb shell dumpsys battery` output. */
export function parseBattery(text: string): BatteryInfo {
  const kv = parseKeyValue(text);
  const num = (k: string): number | null => {
    const v = kv[k];
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const healthCode = num('health');
  const statusCode = num('status');
  const temp = num('temperature');

  return {
    level: num('level'),
    health: healthCode === null ? (kv['health'] ?? null) : BATTERY_HEALTH[healthCode] ?? String(healthCode),
    status: statusCode === null ? (kv['status'] ?? null) : BATTERY_STATUS[statusCode] ?? String(statusCode),
    // dumpsys reports tenths of a degree Celsius.
    temperatureC: temp === null ? null : Math.round(temp) / 10,
    voltageMv: num('voltage'),
    cycleCount: num('cycle count') ?? num('Cycle count'),
  };
}

const BATTERY_HEALTH: Record<number, string> = {
  1: 'UNKNOWN',
  2: 'GOOD',
  3: 'OVERHEAT',
  4: 'DEAD',
  5: 'OVER_VOLTAGE',
  6: 'UNSPECIFIED_FAILURE',
  7: 'COLD',
};

const BATTERY_STATUS: Record<number, string> = {
  1: 'UNKNOWN',
  2: 'CHARGING',
  3: 'DISCHARGING',
  4: 'NOT_CHARGING',
  5: 'FULL',
};

/** `adb shell pm list packages -3` → bare package names. */
export function parsePackages(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^package:(?:.*=)?([A-Za-z][\w.]*\.[\w.]+)$/);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/* ------------------------------------------------------------------ *
 * Profile assembly
 * ------------------------------------------------------------------ */

/** Settings-screen labels (ko/en) mapped onto the getprop key they mirror. */
const LABEL_ALIASES: { re: RegExp; prop: string }[] = [
  { re: /^(?:모델\s*(?:명|번호|이름)|model(?:\s*(?:name|number|no))?)$/i, prop: 'ro.product.model' },
  { re: /^(?:제조사|제조업체|manufacturer|make)$/i, prop: 'ro.product.manufacturer' },
  { re: /^(?:브랜드|brand)$/i, prop: 'ro.product.brand' },
  { re: /^(?:기기\s*이름|디바이스|device(?:\s*name)?)$/i, prop: 'ro.product.device' },
  { re: /^(?:android\s*(?:버전|version)|안드로이드\s*버전|os\s*버전)$/i, prop: 'ro.build.version.release' },
  { re: /^(?:sdk(?:\s*(?:int|버전|level))?|api\s*level)$/i, prop: 'ro.build.version.sdk' },
  { re: /^(?:빌드\s*(?:번호|버전)|build\s*(?:number|id))$/i, prop: 'ro.build.display.id' },
  { re: /^(?:빌드\s*핑거프린트|fingerprint)$/i, prop: 'ro.build.fingerprint' },
  {
    re: /^(?:(?:android\s*)?보안\s*(?:업데이트|패치)(?:\s*(?:수준|레벨))?|security\s*patch(?:\s*level)?|보안\s*업데이트\s*날짜)$/i,
    prop: 'ro.build.version.security_patch',
  },
  { re: /^(?:공급업체\s*보안\s*패치|vendor\s*security\s*patch)$/i, prop: 'ro.vendor.build.security_patch' },
  { re: /^(?:커널\s*버전|kernel(?:\s*version)?)$/i, prop: 'kernel' },
  { re: /^(?:베이스밴드(?:\s*버전)?|baseband(?:\s*version)?|radio)$/i, prop: 'gsm.version.baseband' },
  { re: /^(?:통신사|서비스\s*공급자|carrier|operator|network)$/i, prop: 'gsm.operator.alpha' },
  { re: /^(?:소프트웨어\s*버전|software\s*version|ios\s*(?:버전|version))$/i, prop: 'ios.version' },
];

const TRUE_VALUES = /^(?:1|true|yes|on|enabled|사용|켜짐|활성)$/i;
const FALSE_VALUES = /^(?:0|false|no|off|disabled|사용\s*안\s*함|꺼짐|비활성)$/i;

function toBool(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (TRUE_VALUES.test(v)) return true;
  if (FALSE_VALUES.test(v)) return false;
  return null;
}

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Samsung SKU suffixes are a documented convention; the decode is a hint,
 * not an authoritative lookup.
 */
const SAMSUNG_SUFFIX: Record<string, string> = {
  N: 'Korea (KR carrier SKU)',
  U: 'USA (carrier SKU)',
  U1: 'USA (unlocked SKU)',
  W: 'Canada',
  F: 'Global / Europe',
  B: 'Global / LATAM',
  E: 'LATAM / Asia',
  J: 'Japan',
  '0': 'China (dual SIM)',
};

export function decodeModelHint(model: string | null): string | null {
  if (!model) return null;
  const m = model.trim();

  const samsung = m.match(/^SM-([A-Z])(\d{3,4})([A-Z]?\d?)$/i);
  if (samsung) {
    const suffix = samsung[3].toUpperCase();
    const region = SAMSUNG_SUFFIX[suffix];
    return region
      ? `Samsung SKU · ${region}`
      : 'Samsung SKU · region suffix unrecognised';
  }
  if (/^iPhone\d+,\d+$/i.test(m)) return 'Apple internal iPhone identifier';
  if (/^LM-[A-Z]\d+/i.test(m)) return 'LG Electronics SKU';
  if (/^(?:Pixel|GA\d{5})/i.test(m)) return 'Google Pixel SKU';
  return null;
}

function detectPlatform(props: Record<string, string>): 'android' | 'ios' | 'unknown' {
  if (props['ro.build.version.release'] || props['ro.build.version.sdk'] || props['ro.product.model']) {
    return 'android';
  }
  const model = props['ro.product.model'] ?? '';
  if (props['ios.version'] || /^iPhone|^iPad/i.test(model)) return 'ios';
  return 'unknown';
}

/**
 * Accepts any mix of getprop output, Settings-screen text, `dumpsys battery`
 * and `pm list packages -3` in a single blob and produces one profile.
 */
export function parseDeviceInput(rawInput: string): DeviceProfile {
  const { text, found } = redactIdentifiers(rawInput);

  const props: Record<string, string> = {
    ...parseKeyValue(text),
    // getprop's bracket form is unambiguous, so it wins over loose key:value.
    ...parseGetprop(text),
  };

  // Fold Settings-screen labels onto their getprop equivalents.
  for (const [key, value] of Object.entries(props)) {
    for (const { re, prop } of LABEL_ALIASES) {
      if (re.test(key) && props[prop] === undefined) props[prop] = value;
    }
  }

  const batterySection = /^\s*(?:level|health|status|temperature|voltage)\s*[:=]/im.test(text)
    ? parseBattery(text)
    : { level: null, health: null, status: null, temperatureC: null, voltageMv: null, cycleCount: null };

  const model = props['ro.product.model'] ?? null;
  const platform = detectPlatform(props);
  const release = props['ro.build.version.release'] ?? props['ios.version'] ?? null;
  const buildTags = props['ro.build.tags'] ?? null;

  const consumed = new Set<string>([
    'ro.product.model', 'ro.product.manufacturer', 'ro.product.brand', 'ro.product.device',
    'ro.hardware', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.display.id',
    'ro.build.id', 'ro.build.fingerprint', 'ro.build.type', 'ro.build.tags',
    'ro.build.version.security_patch', 'ro.vendor.build.security_patch', 'kernel',
    'gsm.version.baseband', 'gsm.operator.alpha', 'ro.boot.flash.locked',
    'ro.boot.verifiedbootstate', 'ro.crypto.state', 'ro.boot.selinux', 'ro.debuggable',
    'ro.secure', 'service.adb.tcp.port', 'persist.sys.locale', 'persist.sys.timezone',
    'ios.version',
  ]);

  const unmapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!consumed.has(key) && key.startsWith('ro.')) unmapped[key] = value;
  }

  return {
    platform,
    manufacturer: props['ro.product.manufacturer'] ?? null,
    brand: props['ro.product.brand'] ?? null,
    model,
    modelHint: decodeModelHint(model),
    device: props['ro.product.device'] ?? null,
    hardware: props['ro.hardware'] ?? null,
    release,
    sdkInt: toInt(props['ro.build.version.sdk']),
    buildId: props['ro.build.display.id'] ?? props['ro.build.id'] ?? null,
    buildFingerprint: props['ro.build.fingerprint'] ?? null,
    buildType: props['ro.build.type'] ?? null,
    buildTags,
    securityPatch: normaliseDate(props['ro.build.version.security_patch']),
    vendorSecurityPatch: normaliseDate(props['ro.vendor.build.security_patch']),
    kernel: props['kernel'] ?? null,
    baseband: props['gsm.version.baseband'] ?? null,
    bootloaderLocked: readBootloaderLocked(props),
    verifiedBootState: props['ro.boot.verifiedbootstate'] ?? null,
    encryptionState: props['ro.crypto.state'] ?? null,
    selinux: props['ro.boot.selinux'] ?? null,
    debuggable: toBool(props['ro.debuggable']),
    secureProp: toBool(props['ro.secure']),
    adbEnabled: readAdbEnabled(props),
    adbTcpPort: props['service.adb.tcp.port'] ?? null,
    developerOptions: toBool(props['development_settings_enabled']),
    unknownSources: toBool(props['install_non_market_apps']),
    carrier: props['gsm.operator.alpha'] ?? null,
    locale: props['persist.sys.locale'] ?? null,
    timezone: props['persist.sys.timezone'] ?? null,
    battery: batterySection,
    thirdPartyPackages: parsePackages(text),
    redacted: found,
    unmapped,
  };
}

function readAdbEnabled(props: Record<string, string>): boolean | null {
  const setting = toBool(props['adb_enabled']);
  if (setting !== null) return setting;
  const usb = props['persist.sys.usb.config'] ?? props['sys.usb.config'];
  if (usb !== undefined) return usb.split(',').includes('adb');
  return null;
}

function readBootloaderLocked(props: Record<string, string>): boolean | null {
  const flash = props['ro.boot.flash.locked'];
  if (flash !== undefined) return flash.trim() === '1';
  const vbs = props['ro.boot.verifiedbootstate'];
  if (vbs !== undefined) return vbs.trim().toLowerCase() === 'green';
  return null;
}

/** Accepts `2025-11-01`, `2025.11.01`, `2025년 11월 1일` → `2025-11-01`. */
export function normaliseDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const v = value.trim();

  const iso = v.match(/^(\d{4})[-./](\d{1,2})(?:[-./](\d{1,2}))?/);
  if (iso) {
    const [, y, mo, d] = iso;
    return `${y}-${mo.padStart(2, '0')}-${(d ?? '01').padStart(2, '0')}`;
  }

  const ko = v.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?/);
  if (ko) {
    const [, y, mo, d] = ko;
    return `${y}-${mo.padStart(2, '0')}-${(d ?? '01').padStart(2, '0')}`;
  }

  const parsed = Date.parse(v);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

/* ------------------------------------------------------------------ *
 * Lifecycle knowledge
 * ------------------------------------------------------------------ */

/**
 * Google ships security backports to roughly the three most recent Android
 * releases. This table is a maintenance point — bump it when a release rolls
 * off. OEM windows differ wildly (recent Pixel/Galaxy flagships promise seven
 * years), which is why the patch-date rule below carries more weight than
 * this one.
 */
export const ANDROID_SUPPORT_AS_OF = '2026-07-01';

export const ANDROID_RELEASES: Record<number, { release: string; status: 'supported' | 'ending' | 'eol' }> = {
  21: { release: '5.0', status: 'eol' },
  22: { release: '5.1', status: 'eol' },
  23: { release: '6.0', status: 'eol' },
  24: { release: '7.0', status: 'eol' },
  25: { release: '7.1', status: 'eol' },
  26: { release: '8.0', status: 'eol' },
  27: { release: '8.1', status: 'eol' },
  28: { release: '9', status: 'eol' },
  29: { release: '10', status: 'eol' },
  30: { release: '11', status: 'eol' },
  31: { release: '12', status: 'eol' },
  32: { release: '12L', status: 'eol' },
  33: { release: '13', status: 'eol' },
  34: { release: '14', status: 'ending' },
  35: { release: '15', status: 'supported' },
  36: { release: '16', status: 'supported' },
};

/** Heuristic families whose presence is worth a human look, not a verdict. */
const PACKAGE_WATCHLIST: { re: RegExp; label: string; severity: Severity }[] = [
  { re: /^(?:com\.topjohnwu\.magisk|eu\.chainfire\.supersu|com\.koushikdutta\.superuser|me\.weishu\.kernelsu)$/i, label: 'root manager', severity: 'CRITICAL' },
  { re: /^(?:com\.teamviewer\.|com\.anydesk\.|com\.rsupport\.|com\.airdroid|com\.sand\.airdroid)/i, label: 'remote control / screen sharing', severity: 'MEDIUM' },
  { re: /(?:mspy|flexispy|hoverwatch|cerberus|thetruthspy|spyhuman|mobilespy|trackview)/i, label: 'tracking / monitoring family', severity: 'HIGH' },
  { re: /^(?:com\.guoshi\.httpcanary|app\.greyshirts\.sslcapture|com\.minhui\.networkcapture)/i, label: 'traffic interception (local MITM)', severity: 'MEDIUM' },
];

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

export function daysBetween(from: string, to: Date): number | null {
  const t = Date.parse(from);
  if (Number.isNaN(t)) return null;
  return Math.floor((to.getTime() - t) / DAY_MS);
}

export function analyzeDevice(profile: DeviceProfile, now: Date = new Date()): DeviceIntelReport {
  const findings: Finding[] = [];
  const missing: string[] = [];
  const push = (f: Finding) => findings.push(f);

  /* ---- Security patch level (the single strongest signal) ---- */
  if (profile.securityPatch) {
    const age = daysBetween(profile.securityPatch, now);
    if (age === null) {
      missing.push('security patch level (unparseable)');
    } else if (age > 365) {
      push({
        id: 'patch-abandoned',
        severity: 'CRITICAL',
        title: `보안 패치가 ${age}일 (${Math.floor(age / 30)}개월) 경과`,
        detail: `마지막 보안 패치 수준이 ${profile.securityPatch}입니다. 1년 넘게 공개된 커널·미디어·베이스밴드 취약점이 그대로 남아 있을 가능성이 높습니다.`,
        recommendation: '제조사 업데이트를 확인하고, 더 이상 제공되지 않으면 기기 교체 또는 지원되는 커스텀 ROM 이전을 검토하세요.',
        evidence: `ro.build.version.security_patch=${profile.securityPatch}`,
      });
    } else if (age > 180) {
      push({
        id: 'patch-stale-severe',
        severity: 'HIGH',
        title: `보안 패치가 ${age}일 경과`,
        detail: `마지막 보안 패치 수준이 ${profile.securityPatch}로 6개월 이상 밀려 있습니다.`,
        recommendation: '설정 > 소프트웨어 업데이트에서 즉시 업데이트하세요. 업데이트가 없으면 지원 종료 여부를 확인하세요.',
        evidence: `ro.build.version.security_patch=${profile.securityPatch}`,
      });
    } else if (age > 90) {
      push({
        id: 'patch-stale',
        severity: 'MEDIUM',
        title: `보안 패치가 ${age}일 경과`,
        detail: `마지막 보안 패치 수준이 ${profile.securityPatch}입니다. 월간 패치 주기를 두세 번 놓친 상태입니다.`,
        recommendation: '소프트웨어 업데이트를 실행하고 자동 업데이트를 켜 두세요.',
        evidence: `ro.build.version.security_patch=${profile.securityPatch}`,
      });
    } else if (age > 45) {
      push({
        id: 'patch-slightly-behind',
        severity: 'LOW',
        title: `보안 패치가 ${age}일 경과`,
        detail: '한 주기 정도 밀려 있습니다. 제조사 배포 지연 범위 안일 수 있습니다.',
        recommendation: '업데이트 확인만 한 번 눌러 보세요.',
        evidence: `ro.build.version.security_patch=${profile.securityPatch}`,
      });
    } else {
      push({
        id: 'patch-current',
        severity: 'INFO',
        title: `보안 패치 최신 (${age}일 전)`,
        detail: `패치 수준 ${profile.securityPatch}. 정상적인 월간 업데이트 주기 안에 있습니다.`,
        recommendation: '현재 상태를 유지하세요.',
        evidence: `ro.build.version.security_patch=${profile.securityPatch}`,
      });
    }
  } else {
    missing.push('security patch level');
  }

  /* ---- Vendor patch drift ---- */
  if (profile.securityPatch && profile.vendorSecurityPatch) {
    const drift =
      (Date.parse(profile.securityPatch) - Date.parse(profile.vendorSecurityPatch)) / DAY_MS;
    if (Number.isFinite(drift) && drift > 120) {
      push({
        id: 'vendor-patch-drift',
        severity: 'MEDIUM',
        title: `벤더 패치가 프레임워크 패치보다 ${Math.floor(drift)}일 뒤처짐`,
        detail: `프레임워크는 ${profile.securityPatch}, 벤더(칩셋/드라이버) 영역은 ${profile.vendorSecurityPatch}입니다. 드라이버 계층 취약점이 남아 있을 수 있습니다.`,
        recommendation: '전체 펌웨어(펌웨어 리비전 포함) 업데이트가 적용됐는지 확인하세요.',
        evidence: `ro.vendor.build.security_patch=${profile.vendorSecurityPatch}`,
      });
    }
  }

  /* ---- OS lifecycle ---- */
  if (profile.platform === 'android' && profile.sdkInt !== null) {
    const entry = ANDROID_RELEASES[profile.sdkInt];
    if (!entry) {
      push({
        id: 'android-unknown-sdk',
        severity: 'INFO',
        title: `알 수 없는 SDK 레벨 ${profile.sdkInt}`,
        detail: '지원 테이블에 없는 API 레벨입니다. 최신 릴리스이거나 커스텀 빌드일 수 있습니다.',
        recommendation: 'src/lib/device-intel.ts의 ANDROID_RELEASES 테이블을 갱신하세요.',
        evidence: `ro.build.version.sdk=${profile.sdkInt}`,
      });
    } else if (entry.status === 'eol') {
      push({
        id: 'android-eol',
        severity: profile.sdkInt <= 30 ? 'CRITICAL' : 'HIGH',
        title: `Android ${entry.release} — Google 보안 지원 종료`,
        detail: `API ${profile.sdkInt} (Android ${entry.release})은 ${ANDROID_SUPPORT_AS_OF} 기준 Google의 정기 보안 백포트 대상에서 벗어났습니다. 일부 제조사가 자체 연장 지원을 하는 경우도 있으므로, 위의 보안 패치 날짜가 실제 판단 기준입니다.`,
        recommendation: '상위 버전으로 OS 업그레이드가 가능한지 확인하고, 불가능하면 기기 교체를 계획하세요.',
        evidence: `ro.build.version.sdk=${profile.sdkInt}`,
      });
    } else if (entry.status === 'ending') {
      push({
        id: 'android-ending',
        severity: 'LOW',
        title: `Android ${entry.release} — 지원 종료 임박`,
        detail: `API ${profile.sdkInt}는 지원 창 마지막 구간에 있습니다.`,
        recommendation: '가능하면 상위 버전으로 업그레이드하세요.',
        evidence: `ro.build.version.sdk=${profile.sdkInt}`,
      });
    }
  } else if (profile.platform === 'android') {
    missing.push('Android SDK level');
  }

  /* ---- Boot integrity ---- */
  if (profile.bootloaderLocked === false) {
    push({
      id: 'bootloader-unlocked',
      severity: 'HIGH',
      title: '부트로더 잠금 해제됨',
      detail:
        'Verified Boot 체인이 끊어져 있어 부팅 이미지 변조를 탐지할 수 없습니다. 하드웨어 키 증명(Key Attestation)에 의존하는 은행·간편결제·기업 MDM 앱이 차단되거나 신뢰 수준이 떨어집니다.',
      recommendation: '기기를 초기화하고 부트로더를 다시 잠그세요. 본인이 의도한 상태가 아니라면 중고 구매 이력이나 물리적 접근을 의심해야 합니다.',
      evidence: `ro.boot.verifiedbootstate=${profile.verifiedBootState ?? 'n/a'}`,
    });
  }

  if (profile.verifiedBootState && !/^green$/i.test(profile.verifiedBootState)) {
    const state = profile.verifiedBootState.toLowerCase();
    if (state === 'red') {
      push({
        id: 'verified-boot-red',
        severity: 'CRITICAL',
        title: 'Verified Boot 상태 RED — 부팅 이미지 검증 실패',
        detail: '부팅 파티션이 손상되었거나 변조되었습니다. 정상 기기에서는 나올 수 없는 상태입니다.',
        recommendation: '즉시 사용을 중단하고 공식 펌웨어로 재설치하세요. 민감한 계정은 다른 기기에서 비밀번호를 변경하세요.',
        evidence: 'ro.boot.verifiedbootstate=red',
      });
    } else if (state === 'yellow' || state === 'orange') {
      push({
        id: 'verified-boot-custom',
        severity: 'MEDIUM',
        title: `Verified Boot 상태 ${state.toUpperCase()} — 커스텀 키/이미지`,
        detail:
          state === 'yellow'
            ? '사용자 서명 키로 부팅 이미지가 검증되고 있습니다. 커스텀 ROM 사용자라면 정상입니다.'
            : '부트로더가 잠금 해제되어 검증 없이 부팅합니다.',
        recommendation: '의도한 구성이 아니라면 공식 펌웨어로 복구하세요.',
        evidence: `ro.boot.verifiedbootstate=${state}`,
      });
    }
  }

  /* ---- Build provenance ---- */
  if (profile.buildTags && /test-keys/i.test(profile.buildTags)) {
    push({
      id: 'build-test-keys',
      severity: 'HIGH',
      title: '빌드가 test-keys로 서명됨',
      detail: '공식 릴리스 빌드는 release-keys로 서명됩니다. test-keys는 커스텀 ROM 또는 비공식 빌드를 의미합니다.',
      recommendation: '출처가 불분명한 ROM이라면 공식 펌웨어로 재설치하세요.',
      evidence: `ro.build.tags=${profile.buildTags}`,
    });
  }

  if (profile.buildType && /^(?:userdebug|eng)$/i.test(profile.buildType)) {
    push({
      id: 'build-type-debug',
      severity: 'MEDIUM',
      title: `디버그 빌드 (${profile.buildType})`,
      detail: '소비자용 기기는 user 빌드로 출하됩니다. userdebug/eng 빌드는 루트 셸과 완화된 보안 설정을 포함합니다.',
      recommendation: '일상 사용 기기라면 user 빌드 펌웨어로 교체하세요.',
      evidence: `ro.build.type=${profile.buildType}`,
    });
  }

  if (profile.debuggable === true) {
    push({
      id: 'prop-debuggable',
      severity: 'HIGH',
      title: 'ro.debuggable=1',
      detail: '모든 앱 프로세스에 디버거를 붙일 수 있습니다. 앱 메모리의 토큰·키를 그대로 덤프할 수 있는 상태입니다.',
      recommendation: '공식 user 빌드로 복구하세요.',
      evidence: 'ro.debuggable=1',
    });
  }

  if (profile.secureProp === false) {
    push({
      id: 'prop-insecure',
      severity: 'HIGH',
      title: 'ro.secure=0',
      detail: 'adbd가 root로 실행됩니다. USB 접근만으로 전체 파일시스템을 읽고 쓸 수 있습니다.',
      recommendation: '공식 펌웨어로 복구하세요.',
      evidence: 'ro.secure=0',
    });
  }

  if (profile.selinux && /permissive/i.test(profile.selinux)) {
    push({
      id: 'selinux-permissive',
      severity: 'HIGH',
      title: 'SELinux Permissive 모드',
      detail: '앱·서비스 간 강제 접근 제어가 로깅만 하고 차단하지 않습니다. 권한 상승 익스플로잇의 마지막 방어선이 사라집니다.',
      recommendation: 'Enforcing으로 되돌리거나 공식 펌웨어로 복구하세요.',
      evidence: `ro.boot.selinux=${profile.selinux}`,
    });
  }

  /* ---- Encryption ---- */
  if (profile.encryptionState && !/^encrypted$/i.test(profile.encryptionState)) {
    push({
      id: 'not-encrypted',
      severity: 'HIGH',
      title: `저장소 암호화 상태: ${profile.encryptionState}`,
      detail: '기기를 분실하거나 도난당하면 저장된 데이터를 물리적으로 추출할 수 있습니다.',
      recommendation: '화면 잠금(PIN/패턴/생체)을 설정하면 파일 기반 암호화가 활성화됩니다.',
      evidence: `ro.crypto.state=${profile.encryptionState}`,
    });
  }

  /* ---- Remote debug exposure ---- */
  if (profile.adbTcpPort && profile.adbTcpPort !== '-1' && profile.adbTcpPort !== '0') {
    push({
      id: 'adb-over-network',
      severity: 'CRITICAL',
      title: `네트워크 ADB 활성화 (포트 ${profile.adbTcpPort})`,
      detail:
        '같은 Wi-Fi에 있는 누구나 인증 없이 셸 접근을 시도할 수 있습니다. 공용 Wi-Fi에서는 사실상 무방비 상태입니다.',
      recommendation: '즉시 무선 디버깅을 끄고(`setprop service.adb.tcp.port -1`) 기기를 재부팅하세요.',
      evidence: `service.adb.tcp.port=${profile.adbTcpPort}`,
    });
  }

  if (profile.adbEnabled === true) {
    push({
      id: 'adb-enabled',
      severity: 'LOW',
      title: 'USB 디버깅 활성화',
      detail: '승인된 호스트에 한해 셸 접근이 열립니다. 낯선 PC나 충전기에 연결할 때 위험이 커집니다.',
      recommendation: '필요할 때만 켜고, 개발자 옵션에서 USB 디버깅 승인 목록을 주기적으로 초기화하세요.',
      evidence: 'adb_enabled=1',
    });
  }

  if (profile.developerOptions === true) {
    push({
      id: 'developer-options',
      severity: 'LOW',
      title: '개발자 옵션 활성화',
      detail: '단독으로는 위험하지 않지만 USB 디버깅·모의 위치·OEM 잠금 해제 같은 항목이 함께 노출됩니다.',
      recommendation: '사용하지 않는다면 꺼 두세요.',
      evidence: 'development_settings_enabled=1',
    });
  }

  if (profile.unknownSources === true) {
    push({
      id: 'unknown-sources',
      severity: 'MEDIUM',
      title: '출처를 알 수 없는 앱 설치 허용',
      detail: '스토어 밖에서 받은 APK를 설치할 수 있습니다. 국내에서 유행하는 스미싱 APK의 주요 감염 경로입니다.',
      recommendation: '설정 > 앱 > 특별한 접근 권한에서 앱별 설치 권한을 모두 회수하세요.',
      evidence: 'install_non_market_apps=1',
    });
  }

  /* ---- Installed package watchlist ---- */
  for (const pkg of profile.thirdPartyPackages) {
    for (const entry of PACKAGE_WATCHLIST) {
      if (entry.re.test(pkg)) {
        push({
          id: `package-watch:${pkg}`,
          severity: entry.severity,
          title: `주의 대상 앱 설치됨 — ${pkg}`,
          detail: `분류: ${entry.label}. 패턴 기반 휴리스틱이므로 본인이 의도적으로 설치한 앱일 수 있습니다.`,
          recommendation: '설치한 기억이 없다면 즉시 삭제하고, 설정 > 보안 > 기기 관리자 앱에서 권한을 회수하세요.',
          evidence: pkg,
        });
      }
    }
  }

  if (profile.thirdPartyPackages.length > 0) {
    push({
      id: 'third-party-inventory',
      severity: 'INFO',
      title: `서드파티 앱 ${profile.thirdPartyPackages.length}개`,
      detail: '사전 설치 앱을 제외한 사용자 설치 앱 수입니다.',
      recommendation: '쓰지 않는 앱은 삭제하는 것이 공격 표면을 줄이는 가장 값싼 방법입니다.',
    });
  } else {
    missing.push('installed package list (`pm list packages -3`)');
  }

  /* ---- Battery ---- */
  const b = profile.battery;
  if (b.health && !/^(?:GOOD|UNKNOWN)$/i.test(b.health)) {
    push({
      id: 'battery-health',
      severity: b.health.toUpperCase() === 'DEAD' ? 'HIGH' : 'MEDIUM',
      title: `배터리 상태: ${b.health}`,
      detail: '시스템이 배터리 이상을 보고하고 있습니다.',
      recommendation: '서비스센터에서 배터리 교체를 검토하세요.',
      evidence: `battery.health=${b.health}`,
    });
  }
  if (b.temperatureC !== null && b.temperatureC >= 43) {
    push({
      id: 'battery-temp',
      severity: b.temperatureC >= 48 ? 'HIGH' : 'MEDIUM',
      title: `배터리 온도 ${b.temperatureC}°C`,
      detail: '측정 시점 기준 과열 구간입니다. 지속되면 배터리 수명이 빠르게 줄고 성능 제한이 걸립니다.',
      recommendation: '충전 중 고사양 사용을 피하고, 유휴 상태에서도 높다면 백그라운드에서 도는 앱을 확인하세요.',
      evidence: `battery.temperature=${b.temperatureC}`,
    });
  }
  if (b.level === null) missing.push('battery state (`dumpsys battery`)');

  /* ---- Privacy note ---- */
  if (profile.redacted.length > 0) {
    push({
      id: 'identifiers-redacted',
      severity: 'INFO',
      title: `입력에서 식별자 ${profile.redacted.length}종 제거됨`,
      detail: `제거된 항목: ${profile.redacted.join(', ')}. 분석 결과에는 원본 값이 포함되지 않습니다.`,
      recommendation: '기기 정보를 제3자와 공유할 때는 IMEI·일련번호·전화번호를 항상 가리세요.',
    });
  }

  const order: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
  findings.sort((a, b2) => order.indexOf(a.severity) - order.indexOf(b2.severity));

  const riskScore = Math.min(
    100,
    findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0),
  );

  return {
    profile,
    findings,
    riskScore,
    grade: gradeFor(riskScore),
    summary: buildSummary(profile, findings, riskScore),
    missing,
    generatedAt: now.toISOString(),
  };
}

export function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 60) return 'F';
  if (score >= 40) return 'D';
  if (score >= 20) return 'C';
  if (score >= 8) return 'B';
  return 'A';
}

function buildSummary(profile: DeviceProfile, findings: Finding[], score: number): string {
  const name =
    [profile.manufacturer, profile.model].filter(Boolean).join(' ') ||
    profile.model ||
    '알 수 없는 기기';
  const os =
    profile.platform === 'android' && profile.release
      ? `Android ${profile.release}${profile.sdkInt ? ` (API ${profile.sdkInt})` : ''}`
      : profile.release
        ? `OS ${profile.release}`
        : 'OS 정보 없음';

  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const actionable = (counts.CRITICAL ?? 0) + (counts.HIGH ?? 0) + (counts.MEDIUM ?? 0);

  if (actionable === 0) {
    return `${name} · ${os} — 확인된 위험 신호 없음 (점수 ${score}/100).`;
  }
  return `${name} · ${os} — 조치가 필요한 항목 ${actionable}건 (CRITICAL ${counts.CRITICAL ?? 0} / HIGH ${counts.HIGH ?? 0} / MEDIUM ${counts.MEDIUM ?? 0}), 위험 점수 ${score}/100.`;
}

/** Convenience: raw text in, full report out. */
export function analyzeDeviceText(rawInput: string, now: Date = new Date()): DeviceIntelReport {
  return analyzeDevice(parseDeviceInput(rawInput), now);
}
