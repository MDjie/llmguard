#!/usr/bin/env python3
"""一次性导入工具:konsheng/Sensitive-lexicon -> GuardLLM 检测规则。

把一个分类词库文件转成 1..N 条 type=regex 的检测规则:
  每个词做正则字面量转义 -> (?:词1|词2|...) -> 按约 3900 字符分块 -> 每块一条规则。

用法:
  import-sensitive-lexicon.py <词库目录> <输出.csv> <dimension_id> <tenant_id> <application_id> [score] [confidence]

设计约定(推荐值):
  - 排除体量/噪音大的三个文件:零时-Tencent、非法网址、网易前端过滤敏感词库
  - 清洗:去空白/去空行/去单字符/去纯数字与纯标点/去超长行/全局去重
  - 规则字段: type=regex, match_type=regex, case_sensitive=false
  - 分数/置信度默认 90 / 0.90(可传)
输出 CSV 列与 psql COPY 语句一致:
  tenant_id,application_id,dimension_id,name,type,pattern,match_type,
  case_sensitive,score,confidence,priority,enabled,description
"""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

# 正则字面量转义:只转义 RE2 真正视为元字符的字符,避免无效转义
_META = re.compile(r'[.^$*+?()\[\]{}|\\]')
def esc(term: str) -> str:
    return _META.sub(lambda m: '\\' + m.group(0), term)

# 推荐的排除文件(体量大、内容混杂/URL/噪音,子串误报高)
DEFAULT_EXCLUDE = {
    '零时-Tencent.txt',
    '非法网址.txt',
    '网易前端过滤敏感词库.txt',
}

_ALNUM_CJK = re.compile(r'[A-Za-z0-9一-鿿]')
_DIGITS_ONLY = re.compile(r'^[\d\s]+$')

def clean(terms: list[str]) -> list[str]:
    out: list[str] = []
    for raw in terms:
        t = raw.strip()
        if not t:
            continue
        if len(t) < 2:                       # 去掉单字符噪音(如 x / 温x 之类保留? x=1字符 会被去掉)
            continue
        if len(t) > 512:                     # 去掉异常超长行
            continue
        if _DIGITS_ONLY.match(t):            # 纯数字行
            continue
        if not _ALNUM_CJK.search(t):         # 不含字母/数字/汉字(纯标点/空白类)
            continue
        out.append(t)
    return out

def chunk_terms(terms: list[str], limit: int = 3900) -> list[str]:
    """把转义词分块,每块编译成一条 (?:a|b|...) 且整体 <= limit 字符。"""
    chunks: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for term in terms:
        e = esc(term)
        # 加上当前词后的长度(分隔符 '|' 与前后缀 (?:  )
        add = (len(e) + 1) if cur else len(e)
        if cur and cur_len + add + 4 > limit:
            chunks.append('(?:' + '|'.join(cur) + ')')
            cur = []
            cur_len = 0
            add = len(e)
        cur.append(e)
        cur_len += add
    if cur:
        chunks.append('(?:' + '|'.join(cur) + ')')
    return chunks

def main() -> int:
    if len(sys.argv) < 6:
        print(__doc__)
        return 2
    vocab_dir = Path(sys.argv[1])
    out_csv = Path(sys.argv[2])
    dimension_id = sys.argv[3]
    tenant_id = sys.argv[4]
    application_id = sys.argv[5]
    score = sys.argv[6] if len(sys.argv) > 6 else '90.00'
    confidence = sys.argv[7] if len(sys.argv) > 7 else '0.90'

    files = sorted(p for p in vocab_dir.glob('*.txt')
                   if p.name not in DEFAULT_EXCLUDE)
    if not files:
        print('没有可导入的词库文件(目录下无 *.txt 或全部被排除)。')
        return 1

    # 全局去重:一个词只归属第一次出现的文件,避免跨文件重复
    seen: set[str] = set()
    per_file: list[tuple[str, list[str]]] = []
    total_terms = 0
    for p in files:
        terms = clean(p.read_text(encoding='utf-8', errors='replace').splitlines())
        fresh: list[str] = []
        for t in terms:
            if t not in seen:
                seen.add(t)
                fresh.append(t)
        per_file.append((p.name, fresh))
        total_terms += len(fresh)

    rows: list[list[str]] = []
    rule_no = 0
    for label, terms in per_file:
        if not terms:
            continue
        chunks = chunk_terms(terms)
        for i, pattern in enumerate(chunks, start=1):
            if len(pattern) > 4096:
                print(f'!! {label} 第 {i} 块超出 4096 字符({len(pattern)}),已跳过')
                continue
            rule_no += 1
            name = f'[{label}] 敏感词 {i}'[:100]
            desc = f'source={label}; terms={len(terms)}; block={i}/{len(chunks)}'
            rows.append([
                tenant_id, application_id, dimension_id,
                name, 'regex', pattern, 'regex',
                'false', score, confidence, '100', 'true', desc,
            ])

    with out_csv.open('w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh, quoting=csv.QUOTE_MINIMAL)
        w.writerows(rows)

    print(f'读取文件: {len(files)}')
    for label, terms in per_file:
        nblocks = len(chunk_terms(terms)) if terms else 0
        print(f'  {label:44s} 词={len(terms):5d} 块={nblocks:3d}')
    print(f'全局去重后词数合计: {total_terms}')
    print(f'生成的检测规则: {rule_no}')
    print(f'CSV 已写入: {out_csv}')
    return 0

if __name__ == '__main__':
    sys.exit(main())
