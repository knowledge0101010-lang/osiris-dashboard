'use client';

import { useCallback, useRef, useState } from 'react';
import {
  Smartphone, Loader2, Upload, AlertTriangle, CheckCircle,
  Copy, Check, Trash2, ShieldAlert,
} from 'lucide-react';
import type { DeviceIntelReport, Finding } from '@/lib/device-intel';
import { SEVERITY_COLOR } from '@/lib/device-intel';

const GRADE_COLOR: Record<DeviceIntelReport['grade'], string> = {
  A: '#00E676',
  B: '#76FF03',
  C: '#FFD700',
  D: '#FF9500',
  F: '#FF1744',
};

const PLACEHOLDER = `여기에 붙여넣으세요 — 아래 중 아무거나, 섞어서 넣어도 됩니다.

① 설정 > 휴대전화 정보 화면 (한글/영문 모두 인식)
   모델 번호: SM-S928N
   Android 버전: 15
   보안 업데이트: 2026년 7월 1일

② adb shell getprop 출력
   [ro.build.version.security_patch]: [2026-07-01]

③ adb shell dumpsys battery / pm list packages -3 출력

IMEI·일련번호·전화번호는 분석 전에 자동으로 제거됩니다.`;

const COLLECT_SNIPPET = [
  'adb shell getprop',
  'adb shell dumpsys battery',
  'adb shell pm list packages -3',
  'adb shell settings get global adb_enabled',
].join('\n');

export default function DeviceIntelPanel() {
  const [input, setInput] = useState('');
  const [report, setReport] = useState<DeviceIntelReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const analyze = useCallback(async () => {
    if (!input.trim() || loading) return;
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const res = await fetch('/api/device-intel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReport(data as DeviceIntelReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : '분석에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  const loadFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError('');
    try {
      setInput(await file.text());
    } catch {
      setError('파일을 읽지 못했습니다.');
    }
  }, []);

  const copyReport = useCallback(() => {
    if (!report) return;
    navigator.clipboard.writeText(formatReport(report)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [report]);

  return (
    <div className="flex flex-col gap-2.5">
      {/* Input */}
      <div className="flex flex-col gap-1.5">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onDrop={(e) => { e.preventDefault(); void loadFile(e.dataTransfer.files?.[0]); }}
          onDragOver={(e) => e.preventDefault()}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          className="w-full h-40 resize-y bg-[var(--bg-primary)]/60 border border-[var(--border-primary)] rounded-lg px-3 py-2.5 text-[10px] font-mono leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/40 focus:outline-none transition-colors styled-scrollbar"
          style={{ borderColor: input ? 'rgba(0,229,255,0.25)' : undefined }}
        />

        <div className="flex gap-1.5">
          <button
            onClick={analyze}
            disabled={loading || !input.trim()}
            className="flex-1 px-4 py-2 rounded-lg text-[10px] font-mono font-bold tracking-wider disabled:opacity-30 transition-all flex items-center justify-center gap-2"
            style={{ backgroundColor: '#00E5FF20', border: '1px solid #00E5FF40', color: '#00E5FF' }}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Smartphone className="w-3.5 h-3.5" />}
            {loading ? '분석 중...' : '기기 분석'}
          </button>

          <button
            onClick={() => fileRef.current?.click()}
            title="덤프 파일 불러오기"
            className="px-3 py-2 rounded-lg border border-[var(--border-primary)] text-[var(--text-muted)] hover:bg-[var(--hover-accent)] transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.log,.prop,text/plain"
            className="hidden"
            onChange={(e) => void loadFile(e.target.files?.[0])}
          />

          <button
            onClick={() => { setInput(''); setReport(null); setError(''); }}
            disabled={!input && !report}
            title="지우기"
            className="px-3 py-2 rounded-lg border border-[var(--border-primary)] text-[var(--text-muted)] hover:bg-[var(--hover-accent)] disabled:opacity-30 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        <details className="group">
          <summary className="cursor-pointer list-none text-[9px] font-mono text-[var(--text-muted)] hover:text-[#00E5FF] transition-colors">
            ▸ adb로 수집하는 방법
          </summary>
          <pre className="mt-1.5 p-2 rounded-lg bg-[var(--bg-primary)]/60 border border-[var(--border-primary)] text-[9px] font-mono text-[var(--text-muted)] whitespace-pre-wrap leading-relaxed">
            {COLLECT_SNIPPET}
          </pre>
          <p className="mt-1 text-[9px] font-mono text-[var(--text-muted)]/70 leading-relaxed">
            레포의 <span className="text-[#00E5FF]">scripts/collect-device-info.sh</span> 를 쓰면
            위 네 가지를 한 번에 모아 식별자를 지운 파일로 저장합니다.
          </p>
        </details>
      </div>

      {error && (
        <div className="p-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-[10px] font-mono text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{error}
        </div>
      )}

      {report && <ReportView report={report} onCopy={copyReport} copied={copied} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ReportView({
  report, onCopy, copied,
}: { report: DeviceIntelReport; onCopy: () => void; copied: boolean }) {
  const { profile, findings } = report;
  const actionable = findings.filter((f) => f.severity !== 'INFO');
  const gradeColor = GRADE_COLOR[report.grade];

  return (
    <div className="bg-[var(--bg-primary)]/40 border border-[var(--border-primary)] rounded-lg overflow-hidden max-h-[55vh] overflow-y-auto styled-scrollbar">
      {/* Score header */}
      <div className="p-3 border-b border-[#2A2A28]">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <div className="text-[11px] font-mono tracking-wider text-[var(--text-primary)] truncate">
              {[profile.manufacturer, profile.model].filter(Boolean).join(' ') || '알 수 없는 기기'}
            </div>
            <div className="text-[9px] font-mono text-[#5C5A54] truncate">
              {profile.platform === 'android' && profile.release
                ? `Android ${profile.release}${profile.sdkInt ? ` · API ${profile.sdkInt}` : ''}`
                : profile.release ?? 'OS 정보 없음'}
              {profile.modelHint ? ` · ${profile.modelHint}` : ''}
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-[22px] leading-none font-mono font-bold" style={{ color: gradeColor }}>
              {report.grade}
            </div>
            <div className="text-[8px] font-mono text-[#5C5A54] tracking-wider">
              RISK {report.riskScore}/100
            </div>
          </div>
        </div>

        <div className="w-full h-1.5 rounded-full bg-[#1A1A18] overflow-hidden mb-2">
          <div className="h-full rounded-full transition-all" style={{ width: `${report.riskScore}%`, backgroundColor: gradeColor }} />
        </div>

        <p className="text-[9px] font-mono text-[#8A8880] leading-relaxed">{report.summary}</p>

        <button
          onClick={onCopy}
          className="mt-2 w-full py-1.5 rounded-lg border border-[var(--border-primary)] text-[9px] font-mono tracking-wider text-[var(--text-muted)] hover:bg-[var(--hover-accent)] transition-colors flex items-center justify-center gap-1.5"
        >
          {copied ? <Check className="w-3 h-3 text-[#00E676]" /> : <Copy className="w-3 h-3" />}
          {copied ? '복사됨' : '리포트 복사 (식별자 제거된 상태)'}
        </button>
      </div>

      {/* Findings */}
      <div className="p-3 border-b border-[#2A2A28]">
        <div className="flex items-center gap-1.5 mb-2">
          <ShieldAlert className="w-3 h-3 text-[#FF9500]" />
          <span className="text-[9px] font-mono text-[var(--text-muted)] tracking-widest">
            발견 사항 {actionable.length > 0 ? `(조치 필요 ${actionable.length})` : ''}
          </span>
        </div>

        {actionable.length === 0 && (
          <div className="flex items-center gap-1.5 text-[9px] font-mono text-[#00E676] mb-2 px-1">
            <CheckCircle className="w-3 h-3" /> 조치가 필요한 위험 신호가 없습니다.
          </div>
        )}

        <div className="space-y-1">
          {findings.map((f) => <FindingRow key={f.id} finding={f} />)}
        </div>
      </div>

      {/* Profile facts */}
      <div className="p-3 border-b border-[#2A2A28]">
        <div className="text-[9px] font-mono text-[var(--text-muted)] tracking-widest mb-2">기기 프로필</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <Fact label="제조사" value={profile.manufacturer} />
          <Fact label="모델" value={profile.model} />
          <Fact label="OS" value={profile.release} />
          <Fact label="SDK" value={profile.sdkInt} />
          <Fact label="빌드" value={profile.buildId} />
          <Fact label="빌드 타입" value={profile.buildType} />
          <Fact label="보안 패치" value={profile.securityPatch} />
          <Fact label="벤더 패치" value={profile.vendorSecurityPatch} />
          <Fact label="커널" value={profile.kernel} />
          <Fact label="베이스밴드" value={profile.baseband} />
          <Fact label="부트로더" value={boolLabel(profile.bootloaderLocked, '잠김', '해제됨')} />
          <Fact label="Verified Boot" value={profile.verifiedBootState} />
          <Fact label="암호화" value={profile.encryptionState} />
          <Fact label="SELinux" value={profile.selinux} />
          <Fact label="USB 디버깅" value={boolLabel(profile.adbEnabled, '켜짐', '꺼짐')} />
          <Fact label="배터리" value={profile.battery.level === null ? null : `${profile.battery.level}% · ${profile.battery.health ?? '?'}`} />
          <Fact label="서드파티 앱" value={profile.thirdPartyPackages.length || null} />
          <Fact label="제거된 식별자" value={profile.redacted.length ? profile.redacted.join(', ') : '없음'} />
        </div>
      </div>

      {/* Missing inputs */}
      {report.missing.length > 0 && (
        <div className="p-3">
          <div className="text-[9px] font-mono text-[var(--text-muted)] tracking-widest mb-1.5">
            더 넣으면 정확해지는 입력
          </div>
          <ul className="space-y-0.5">
            {report.missing.map((m) => (
              <li key={m} className="text-[9px] font-mono text-[#8A8880]">· {m}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false);
  const color = SEVERITY_COLOR[finding.severity];

  return (
    <div className="rounded border-l-2 bg-white/[0.02] hover:bg-white/5 transition-colors" style={{ borderLeftColor: color }}>
      <button onClick={() => setOpen((o) => !o)} className="w-full px-2 py-1.5 text-left">
        <div className="flex items-start justify-between gap-2">
          <span className="text-[10px] font-mono leading-tight text-[var(--text-primary)]">{finding.title}</span>
          <span
            className="text-[7px] font-mono font-bold px-1 py-0.5 rounded flex-shrink-0"
            style={{ backgroundColor: color, color: '#000' }}
          >
            {finding.severity}
          </span>
        </div>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1">
          <p className="text-[9px] font-mono text-[#8A8880] leading-relaxed">{finding.detail}</p>
          <p className="text-[9px] font-mono leading-relaxed" style={{ color }}>
            → {finding.recommendation}
          </p>
          {finding.evidence && (
            <p className="text-[8px] font-mono text-[#5C5A54] break-all">근거: {finding.evidence}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <span className="text-[8px] font-mono text-[#5C5A54] flex-shrink-0">{label}</span>
      <span className="text-[9px] font-mono text-[var(--text-primary)] truncate text-right" title={value === null ? undefined : String(value)}>
        {value === null || value === '' ? '—' : String(value)}
      </span>
    </div>
  );
}

function boolLabel(value: boolean | null, yes: string, no: string): string | null {
  if (value === null) return null;
  return value ? yes : no;
}

/** Plain-text export — already identifier-free, safe to paste anywhere. */
function formatReport(report: DeviceIntelReport): string {
  const lines = [
    '# OSIRIS Device Intel',
    report.summary,
    `Grade ${report.grade} · Risk ${report.riskScore}/100 · ${report.generatedAt}`,
    '',
    '## Findings',
    ...report.findings.map(
      (f) => `- [${f.severity}] ${f.title}\n  ${f.detail}\n  → ${f.recommendation}`,
    ),
  ];
  if (report.missing.length) {
    lines.push('', '## Missing inputs', ...report.missing.map((m) => `- ${m}`));
  }
  return lines.join('\n');
}
