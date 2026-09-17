export interface ExternalCutoffRule {
  statusCodes: number[];
  keywords: string[];
  description: string;
}

export interface ExternalCutoffCandidate {
  accountId: number;
  requestId?: string | null;
  statusCode?: number | null;
  phase?: string | null;
  text: string;
}

export interface ExternalCutoffMatch {
  matched: boolean;
  keyword: string | null;
  ruleIndex: number | null;
  description: string | null;
}

export function matchExternalCutoff(candidate: ExternalCutoffCandidate, rules: ExternalCutoffRule[]): ExternalCutoffMatch {
  const text = candidate.text.toLocaleLowerCase("en-US");
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]!;
    if (candidate.statusCode !== null && candidate.statusCode !== undefined && !rule.statusCodes.includes(candidate.statusCode)) continue;
    const keyword = rule.keywords.find((item) => text.includes(item.toLocaleLowerCase("en-US")));
    if (keyword) return { matched: true, keyword, ruleIndex: index, description: rule.description };
  }
  return { matched: false, keyword: null, ruleIndex: null, description: null };
}
