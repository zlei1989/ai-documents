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

/* ------------------------------------------------------------------ */
/* 世界银行：发展报告 / 研究文档                                       */
/* ------------------------------------------------------------------ */

/** 世界银行文档搜索（documents & reports），不是指标 API */
export const worldBankSource: ResearchSource = {
  id: 'worldbank',
  label: '世界银行文档库',
  routing: '世界银行的发展报告、研究论文、国别评估；写发展/经济/公共政策类内容查报告与数据来源',
  async search(input, ctx): Promise<SourceSearchOutput> {
    const url = `https://search.worldbank.org/api/v2/wds?format=json&qterm=${encodeQuery(input.query)}&rows=${limitOf(input)}`;
    const json = asRecord(await getJson(url, ctx));
    const total = asNumber(json.total);
    const documentsRaw = json.documents;
    const documents = Array.isArray(documentsRaw) ? documentsRaw : Object.values(asRecord(documentsRaw));
    const hits: SourceHit[] = documents.map((raw) => {
      const doc = asRecord(raw);
      const title = cleanText(asString(doc.display_title) || asString(asRecord(asArray(doc.docna)[0]).docna)) || '（无标题）';
      const abstractRaw = doc.abstracts;
      const abstract =
        typeof abstractRaw === 'string'
          ? abstractRaw
          : cleanText(asString(asRecord(abstractRaw)['cdata!']) || asString(asRecord(abstractRaw).cdata));
      const date = asString(doc.docdt).slice(0, 10);
      const id = asString(doc.id) || asString(doc.guid);
      return {
        title,
        url: asString(doc.url) || asString(doc.new_url) || asString(doc.pdfurl),
        ...(abstract ? { snippet: truncate(cleanText(abstract), 400) } : {}),
        meta: [cleanText(asString(doc.docty)), date, cleanText(asString(doc.lang))].filter(Boolean).join(' · '),
        ...(id ? { dedupeKey: `wb:${id}` } : {}),
      };
    });
    return { hits: hits.filter((hit) => hit.url), ...(total !== undefined ? { note: `共 ${total.toLocaleString('en-US')} 条` } : {}) };
  },
};

/* ------------------------------------------------------------------ */
/* Eurostat：常用数据集目录（内置精选，避免每次拉 2MB 全量目录）        */
/* ------------------------------------------------------------------ */

interface EurostatDataset {
  code: string;
  title: string;
  /** 中文/别名关键词，提升中文查询命中 */
  keywords: string;
}

/**
 * 精选常用数据集（覆盖 GDP/就业/通胀/人口/能源/环境/贸易/旅游/贫困/教育/财政/研发/房价/工资/寿命/庇护/医疗）。
 * 全量目录有 8,700+ 个数据集、约 2MB，不适合每次查询都拉；冷门数据集交给 web 源。
 */
const EUROSTAT_DATASETS: EurostatDataset[] = [
  { code: 'nama_10_gdp', title: 'Gross domestic product (GDP) and main components - annual data', keywords: 'gdp 国内生产总值 经济 增长 national accounts' },
  { code: 'namq_10_gdp', title: 'Gross domestic product (GDP) and main components - quarterly data', keywords: 'gdp 国内生产总值 季度' },
  { code: 'nama_10_pc', title: 'Gross domestic product (GDP) and main components per capita - annual data', keywords: 'gdp 人均 国内生产总值 per capita' },
  { code: 'sdg_08_10', title: 'Real GDP per capita', keywords: 'gdp 实际 人均 增长' },
  { code: 'une_rt_a', title: 'Unemployment by sex and age - annual data', keywords: 'unemployment 失业率 就业' },
  { code: 'une_rt_m', title: 'Unemployment by sex and age - monthly data', keywords: 'unemployment 失业率 月度' },
  { code: 'lfsa_urgan', title: 'Unemployment rates by citizenship', keywords: 'unemployment 失业 国籍' },
  { code: 'lfsa_egan', title: 'Employed persons by citizenship', keywords: 'employment 就业 雇员 国籍' },
  { code: 'lfsa_ergan', title: 'Employment rates by citizenship', keywords: 'employment 就业率' },
  { code: 'prc_hicp_manr', title: 'HICP - monthly data (annual rate of change)', keywords: 'inflation 通胀 消费者物价 hicp cpi' },
  { code: 'prc_hicp_midx', title: 'HICP - monthly data (index)', keywords: 'inflation 物价指数 hicp' },
  { code: 'demo_gind', title: 'Population change - Demographic balance and crude rates at national level', keywords: 'population 人口 出生 死亡 迁移' },
  { code: 'demo_pjan', title: 'Population on 1 January by age and sex', keywords: 'population 人口 年龄 性别' },
  { code: 'tps00001', title: 'Population on 1 January', keywords: 'population 人口 总数' },
  { code: 'tps00010', title: 'Population by age group', keywords: 'population 人口 年龄结构 老龄化' },
  { code: 'demo_mlexpec', title: 'Life expectancy by age and sex', keywords: 'life expectancy 预期寿命 寿命' },
  { code: 'env_air_gge', title: 'Greenhouse gas emissions by source sector', keywords: 'emissions 温室气体 排放 碳 环境' },
  { code: 'sdg_13_10', title: 'Domestic net greenhouse gas emissions', keywords: 'emissions 温室气体 排放 气候' },
  { code: 'nrg_ind_ren', title: 'Renewable energy share', keywords: 'renewable 可再生 能源 占比' },
  { code: 'nrg_bal_c', title: 'Complete energy balances', keywords: 'energy 能源 平衡表 电力' },
  { code: 'isoc_ci_it_en2', title: 'Type of connections to the internet by NACE Rev. 2 activity', keywords: 'internet 互联网 宽带 数字化' },
  { code: 'tour_occ_ninat', title: 'Nights spent at tourist accommodation establishments', keywords: 'tourism 旅游 住宿 过夜' },
  { code: 'ext_lt_maineu', title: 'Extra-EU trade by partner', keywords: 'trade 贸易 进出口 伙伴' },
  { code: 'ilc_li02', title: 'At-risk-of-poverty rate by poverty threshold, age and sex', keywords: 'poverty 贫困 贫困率 收入' },
  { code: 'edat_lfse_03', title: 'Population in private households by educational attainment level', keywords: 'education 教育 学历 受教育程度' },
  { code: 'gov_10dd_edpt1', title: 'Government deficit/surplus, debt and associated data', keywords: 'deficit 债务 财政 赤字 政府' },
  { code: 'rd_e_gerdtot', title: 'GERD by sector of performance', keywords: 'r&d 研发 科研 投入' },
  { code: 'prc_hpi_a', title: 'House price index - annual data', keywords: 'house price 房价 房地产 指数' },
  { code: 'earn_mw_cur', title: 'Monthly minimum wages - bi-annual data', keywords: 'minimum wage 最低工资 薪资' },
  { code: 'sts_inpr_a', title: 'Production in industry - annual data', keywords: 'industry 工业 生产 制造业' },
  { code: 'sts_trtu_a', title: 'Turnover and volume of sales in wholesale and retail trade - annual data', keywords: 'retail 零售 批发 销售' },
  { code: 'migr_asyappctza', title: 'Asylum applicants by type, citizenship, age and sex', keywords: 'asylum 庇护 难民 移民' },
  { code: 'tps00207', title: 'Total health care expenditure', keywords: 'health 医疗 卫生 支出' },
  { code: 'tps00116', title: 'Death due to cancer, by sex', keywords: 'cancer 癌症 死亡 健康' },
  { code: 'tps00206', title: 'Crude marriage rate', keywords: 'marriage 结婚 婚姻 人口' },
];

/** Eurostat：常用欧盟统计数据集的本地目录（无需网络） */
export const eurostatSource: ResearchSource = {
  id: 'eurostat',
  label: 'Eurostat 欧盟统计',
  routing: '欧盟官方统计的常用数据集（GDP/失业/通胀/人口/能源/排放/贸易/旅游/贫困/教育/财政/研发/房价/工资/寿命等）；给数据集名与链接，具体数值可再用 web 查',
  async search(input): Promise<SourceSearchOutput> {
    const query = input.query.toLowerCase().trim();
    const tokens = query.split(/\s+/).filter((token) => token.length >= 2);
    const score = (dataset: EurostatDataset): number => {
      const haystack = `${dataset.title} ${dataset.keywords} ${dataset.code}`.toLowerCase();
      if (haystack.includes(query)) return 3;
      if (tokens.length > 0 && tokens.every((token) => haystack.includes(token))) return 2;
      if (tokens.length > 0 && tokens.some((token) => haystack.includes(token))) return 1;
      return 0;
    };
    const matched = EUROSTAT_DATASETS.map((dataset) => ({ dataset, score: score(dataset) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.dataset);

    const hits: SourceHit[] = matched.slice(0, limitOf(input)).map((dataset) => ({
      title: dataset.title,
      url: `https://ec.europa.eu/eurostat/databrowser/view/${dataset.code}/default/table?lang=en`,
      meta: dataset.code,
      dedupeKey: `eurostat:${dataset.code}`,
    }));
    return {
      hits,
      note: `内置 ${EUROSTAT_DATASETS.length} 个常用数据集，匹配 ${matched.length} 个（冷门数据集请用 web）`,
    };
  },
};
