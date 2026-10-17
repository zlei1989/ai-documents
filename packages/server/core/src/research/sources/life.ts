import { cleanText, encodeQuery, getJson, truncate } from '../http';
import type { ResearchSource, SourceHit, SourceSearchOutput } from '../types';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function limitOf(input: { limit: number }): number {
  return Math.min(10, Math.max(1, input.limit));
}

/** GBIF：物种 / 分类学 / 分布 */
export const gbifSource: ResearchSource = {
  id: 'gbif',
  label: 'GBIF 物种库',
  routing: '动植物/微生物的学名、分类地位、分布记录；写科普/生物类内容查物种信息用它',
  async search(input, ctx): Promise<SourceSearchOutput> {
    const json = asRecord(
      await getJson(`https://api.gbif.org/v1/species/search?q=${encodeQuery(input.query)}&limit=${limitOf(input)}`, ctx),
    );
    const total = asNumber(json.count);
    const results = asArray(json.results);
    const hits: SourceHit[] = results.map((raw) => {
      const item = asRecord(raw);
      const key = asNumber(item.key) ?? asNumber(item.nubKey);
      const scientificName = cleanText(asString(item.scientificName) || asString(item.canonicalName));
      const rank = cleanText(asString(item.rank));
      const status = cleanText(asString(item.taxonomicStatus));
      const classification = ['kingdom', 'phylum', 'class', 'order', 'family']
        .map((field) => cleanText(asString(item[field])))
        .filter(Boolean)
        .join(' > ');
      return {
        title: scientificName || '（无学名）',
        url: key ? `https://www.gbif.org/species/${key}` : 'https://www.gbif.org/',
        ...(classification ? { snippet: truncate(classification, 200) } : {}),
        meta: [rank, status, asNumber(item.numDescendants) !== undefined ? `下辖 ${asNumber(item.numDescendants)}` : '']
          .filter(Boolean)
          .join(' · '),
        ...(key ? { dedupeKey: `gbif:${key}` } : {}),
      };
    });
    return { hits, ...(total !== undefined ? { note: `共 ${total.toLocaleString('en-US')} 条` } : {}) };
  },
};

/** ClinicalTrials.gov：临床试验注册（用 fields 参数压小响应） */
export const clinicalTrialsSource: ResearchSource = {
  id: 'clinicaltrials',
  label: 'ClinicalTrials.gov 临床试验',
  routing: '临床试验的注册号、状态、适应症、分期、申办方、入组人数；医学/药物类内容用它查「有没有这项试验」',
  async search(input, ctx): Promise<SourceSearchOutput> {
    const fields = [
      'NCTId',
      'BriefTitle',
      'OverallStatus',
      'Condition',
      'StartDate',
      'BriefSummary',
      'Phase',
      'EnrollmentCount',
      'LeadSponsorName',
    ].join(',');
    const url =
      `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeQuery(input.query)}` +
      `&pageSize=${limitOf(input)}&fields=${fields}`;
    const json = asRecord(await getJson(url, ctx));
    const studies = asArray(json.studies);
    const hits: SourceHit[] = studies.map((raw) => {
      const protocol = asRecord(asRecord(raw).protocolSection);
      const identification = asRecord(protocol.identificationModule);
      const status = asRecord(protocol.statusModule);
      const design = asRecord(protocol.designModule);
      const sponsor = asRecord(asRecord(protocol.sponsorCollaboratorsModule).leadSponsor);
      const conditions = asArray(asRecord(protocol.conditionsModule).conditions).map(asString);
      const summary = cleanText(asString(asRecord(protocol.descriptionModule).briefSummary));
      const nctId = asString(identification.nctId);
      return {
        title: cleanText(asString(identification.briefTitle)) || '（无标题）',
        url: nctId ? `https://clinicaltrials.gov/study/${nctId}` : '',
        ...(summary ? { snippet: truncate(summary, 300) } : {}),
        meta: [
          nctId,
          cleanText(asString(status.overallStatus)),
          asArray(design.phases).map(asString).join('/'),
          cleanText(asString(sponsor.name)),
          conditions.slice(0, 2).join('/'),
          asString(asRecord(status.startDateStruct).date),
        ]
          .filter(Boolean)
          .join(' · '),
        ...(nctId ? { dedupeKey: `nct:${nctId}` } : {}),
      };
    });
    return { hits: hits.filter((hit) => hit.url) };
  },
};
