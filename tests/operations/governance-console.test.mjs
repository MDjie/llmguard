import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(path, 'utf8');

describe('policy governance consoles', () => {
  it('exposes dictionary lifecycle, conflict tests, trends and rollback on mobile and desktop', () => {
    const page = read('src/app/dictionaries/page.tsx');
    for (const marker of ['校验', '正反例', '7 日命中', 'SHADOW', 'CANARY', '回滚', 'md:hidden', 'md:block']) {
      expect(page).toContain(marker);
    }
  });

  it('exposes template selectors, variable allowlists, approval and recheck', () => {
    const page = read('src/app/response-templates/page.tsx');
    for (const marker of ['风险类别', '变量白名单', '审批', '回滚', '模板预览与安全复检', 'md:hidden']) {
      expect(page).toContain(marker);
    }
  });

  it('shows runtime generation and protected evidence access in the existing consoles', () => {
    expect(read('src/app/policy-releases/page.tsx')).toContain('<PolicyRuntimeStatus />');
    expect(read('src/components/policy/policy-runtime-status.tsx')).toContain('generation');
    expect(read('src/app/incidents/page.tsx')).toContain('<EvidenceAccessPanel');
    const evidence = read('src/components/incidents/evidence-access-panel.tsx');
    expect(evidence).toContain('双人审批');
    expect(evidence).toContain('一次性查看');
  });
});
