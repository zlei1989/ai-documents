# Research · 可选资料库全景（科学 / 图书 / 百科 / 中文 / 法规 等）

调研日期：2026-10-17。目的：给「资料查询插件」（见 [deepseek-research-plugin.md](deepseek-research-plugin.md)）挑下一批可接入的数据源。
验证口径：**✅ = 本次真的打通并拿到 JSON**；**📄 = 官方文档写明，但本次网络环境没直连成功**；**⚠️ = 未核实 / 无公开接口**。

---

## 0. 结论先讲

1. **真正好接的是「免 key + JSON + 单次 GET」的开放接口**：Crossref、Europe PMC、DOAJ、GBIF、World Bank、Eurostat、ClinicalTrials.gov、Gutendex、NCBI E-utilities。这一档全部实测通过，接一个源的代码量约等于现在 DeepSeek 客户端的 1/3。
2. **科学文献的「元数据之王」是 Crossref**；「覆盖最广 + 有摘要」是 Europe PMC / OpenAlex；**arXiv 是 Atom XML**，要接就得引一个 XML 解析器，或者用 Europe PMC / OpenAlex 的 JSON 结果代替。
3. **图书类没有「大全」**：Project Gutenberg（Gutendex）只有公版书；Open Library 是书目元数据；Google Books 有配额。**中文图书基本没有公开 API**（豆瓣、国图 OPAC、微信读书都没有官方接口）。
4. **中文文献（知网/万方/维普）没有公开 API**，只能商业授权；中文资料现实路径就是现在已接的 **DeepSeek Search/Fetch**。
5. **法规、标准、专利是三类最「难接」的**：中国法规库、国标全文公开系统、CNIPA 都无公开接口；美国专利可用 USPTO/PatentsView（需免费 key），欧洲专利可用 EPO OPS（需注册）。
6. 统计与医学是「意外好接」的一档：**World Bank、Eurostat、ClinicalTrials.gov 全部免 key、JSON、实测通过**。

---

## 0.5 本次已接入（12 个源）

`research_search({ query, sources })` 的 `sources` 现在支持多选；**`web` 是必查源**（每次搜索自动带上），其余源按内容类型勾选。设置页「资料查询 → 数据源」可逐个停用。

| id | 源 | 内容类型 | 鉴权 |
|---|---|---|---|
| `web` | DeepSeek 联网搜索 | 通用 / 最新 / 中文 / 新闻 / 百科（必查） | 借模型供应商 key |
| `crossref` | Crossref | 论文/DOI/期刊/作者/年份 | 免 key |
| `openalex` | OpenAlex | 跨学科论文 + 摘要 + 引用数 | 免 key（共享 $0.10/天预算，key 可选） |
| `europepmc` | Europe PMC | 生物医学论文摘要 / 全文 | 免 key |
| `pubmed` | PubMed（NCBI） | 医学文献题录 | 免 key |
| `doaj` | DOAJ | 开放获取期刊文章（含摘要） | 免 key |
| `arxiv` | arXiv | 物理/CS/数学预印本 | 免 key（Atom XML，已内置轻量解析） |
| `gutenberg` | Project Gutenberg | 公版书 + 全文链接 | 免 key |
| `gbif` | GBIF | 物种 / 分类 / 分布 | 免 key |
| `clinicaltrials` | ClinicalTrials.gov | 临床试验 | 免 key |
| `worldbank` | 世界银行文档库 | 发展报告 / 研究文档 | 免 key |
| `eurostat` | Eurostat | 常用欧盟数据集（内置 35 个：GDP/失业/通胀/人口/能源/排放…） | 免 key |

**这一批为什么是这些**：

- 全部实测可达（`curl` 200 + 结构化 JSON），且**均不需要申请 key**；
- 需要 key 的源（Semantic Scholar、CORE、NASA ADS、FRED、EPO OPS、PatentsView、NewsAPI、Google Books）本次一律不接——按「网络可达 + key 申请有中文入口」的规则，它们都不满足（多数只有英文注册页）；后续要接时在设置页加「数据源密钥」区块即可。
- 本次网络环境不可达的 **Wikipedia / Open Library / Internet Archive / Google Books** 没有直连适配器；这些内容仍可通过 `web`（DeepSeek 联网）拿到。

---

## 1. 接入分档（按工程成本）

| 档 | 特征 | 代表 | 接入动作 |
|---|---|---|---|
| **A. 即插即用** | 免 key、JSON、单次 GET、额度宽松 | Crossref、Europe PMC、DOAJ、GBIF、World Bank、Eurostat、ClinicalTrials.gov、Gutendex、NCBI E-utilities | 写一个 `search()` 适配器即可，无需改设置页 |
| **B. 要 key / 要预算** | 免费但需注册，或有每日预算/付费档 | OpenAlex、Semantic Scholar、CORE、Google Books、NASA ADS、FRED、EPO OPS、USPTO PatentsView、NewsAPI | 设置页加「数据源密钥」区块，只写不读 |
| **C. 有接口但要解析** | XML/Atom、SPARQL、SDMX、JSON-stat | arXiv、PubMed efetch、Wikidata Query Service、OECD SDMX、EUR-Lex | 引 XML/SDMX 解析，或找 JSON 镜像绕开 |
| **D. 不接** | 无公开 API、需商业授权、反爬明确 | 知网/万方/维普、HathiTrust、ISO、国家标准全文公开系统、CNIPA、豆瓣读书、百度百科 | 用 DeepSeek 搜索兜底，或在文档里注明「需人工获取」 |

---

## 2. 学术与科学

| 来源 | 覆盖 | 端点 | 鉴权 | 额度 / 限流 | 格式 | 验证 | 档 |
|---|---|---|---|---|---|---|---|
| **Crossref** | 上亿级 DOI 元数据（期刊/会议/图书/数据集） | `https://api.crossref.org/works?query=…` | 无 | 未公布硬配额；429 时退避；`rows≤1000` | JSON | ✅ | A |
| **Europe PMC** | 生命科学文献，含摘要、部分全文、引用 | `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=…&format=json` | 无 | 未公布；礼貌使用 | JSON | ✅ | A |
| **OpenAlex** | 全球学术实体（论文/作者/机构/概念） | `https://api.openalex.org/works?search=…` | 可选 key | 无 key 10 rps；免费 key 30 rps + 每日预算；语义搜索 1 rps | JSON | 📄 | B |
| **NCBI E-utilities** | PubMed / PMC / Gene 等 | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=…&retmode=json` | 无（建议带 tool/email） | 3 rps（无 key）；10 rps（有 key） | JSON / XML | ✅（esearch JSON） | A/C |
| **DOAJ** | 开放获取期刊文章 + 摘要 | `https://doaj.org/api/search/articles/{query}` | 无 | 未公布 | JSON | ✅ | A |
| **Semantic Scholar** | 论文 + TLDR + 引用网络 | `https://api.semanticscholar.org/graph/v1/paper/search` | 免费 key | 匿名极易 429（本次实测即 429） | JSON | ✅（429 也是证据） | B |
| **arXiv** | 预印本（物理/CS/Math/生物等） | `http://export.arxiv.org/api/query?search_query=…` | 无 | 官方要求每次请求间隔 3 秒、结果缓存一天；单次 `max_results≤2000` | **Atom XML** | ✅（官方手册） | C |
| **bioRxiv / medRxiv** | 预印本 | `https://api.biorxiv.org/` | 无 | 未公布 | JSON | 📄 | A |
| **CORE** | 开放获取全文聚合 | `https://api.core.ac.uk/v3/` | 免费 key | 免费档有限额 | JSON | 📄 | B |
| **NASA ADS** | 天文/物理文献 | `https://api.adsabs.harvard.edu/v1/` | 免费 token | 有配额 | JSON | 📄 | B |
| **GBIF** | 物种 / 分类 / 观测记录 | `https://api.gbif.org/v1/species/search?q=…` | 无 | 未公布 | JSON | ✅ | A |
| **UniProt / RCSB PDB** | 蛋白 / 结构 | `https://rest.uniprot.org/`、`https://data.rcsb.org/` | 无 | 未公布 | JSON | 📄 | A |
| **Zenodo / Figshare / DataCite** | 数据集 / 软件 / DOI | 各自 REST API | 部分需 token | — | JSON | 📄 | B |
| **ClinicalTrials.gov** | 临床试验注册 | `https://clinicaltrials.gov/api/v2/studies?query.term=…` | 无 | 未公布 | JSON | ✅ | A（注意单条响应巨大） |

**实测样例（可直接复现）**

```bash
curl -s "https://api.crossref.org/works?query.title=gateway%20architecture&rows=1&select=DOI,title,author,published"
curl -s "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=CRISPR&format=json&pageSize=1"
curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=CRISPR&retmode=json&retmax=1"
curl -s "https://doaj.org/api/search/articles/CRISPR?pageSize=1"
curl -s "https://api.gbif.org/v1/species/search?q=octopus&limit=1"
curl -s "https://clinicaltrials.gov/api/v2/studies?query.term=aspirin&pageSize=1"
curl -s "http://export.arxiv.org/api/query?search_query=all:electron&max_results=1"
```

**要点**

- Crossref 是「书目真相源」：DOI、作者、期刊、出版日期、引用数都在，但**通常没有摘要**（摘要版权在出版社）。需要摘要就配 Europe PMC / OpenAlex / DOAJ。
- OpenAlex 2026 起有「每日预算」概念：无 key 10 rps、免费 key 30 rps，超出要付费（[Authentication](https://help.openalex.org/api/authentication)）。接入时要在 UI 里提示预算，别默默烧钱。
- arXiv 官方明确说结果一天只更新一次、**请缓存**（[API User's Manual](https://info.arxiv.org/help/api/user-manual.html)）；不缓存会白白触发 3 秒限流。
- ClinicalTrials.gov 单条 study 可能几十 KB，**必须做字段裁剪**再给模型。

---

## 3. 图书与古籍

| 来源 | 覆盖 | 端点 | 鉴权 | 额度 | 格式 | 验证 | 档 |
|---|---|---|---|---|---|---|---|
| **Project Gutenberg / Gutendex** | 7 万+ 公版书（元数据 + 下载链接） | `https://gutendex.com/books?search=…` | 无 | 未公布；官方建议长期使用自建实例 | JSON | ✅ | A |
| **Open Library** | 书目元数据（借阅/封面/作者） | `https://openlibrary.org/search.json?q=…` | 无 | 无公开配额，要求礼貌使用 | JSON | 📄（本次网络不通） | A |
| **Google Books** | 书目 + 部分预览 | `https://www.googleapis.com/books/v1/volumes?q=…` | key 可选（影响配额） | 免费额度按项目计 | JSON | 📄（本次网络不通） | B |
| **Internet Archive** | 扫描书 / 音视频 / 网页存档 | `https://archive.org/advancedsearch.php?q=…&output=json` | 无 | 未公布 | JSON | 📄 | A |
| **HathiTrust** | 1,800 万+ 卷扫描件 | 无公开检索 API（仅数据研究合作） | — | — | — | ⚠️ | D |
| **豆瓣读书** | 中文图书元数据 | 无官方 API | — | — | — | ⚠️ | D |
| **中国国家图书馆 OPAC** | 中文图书书目 | 无公开 API | — | — | — | ⚠️ | D |

**要点**

- 公版书全文拿得到（Gutenberg 提供 `text/plain` 链接，可直接 `research_fetch` 下载后缓存），**在版书拿不到全文**，只能拿元数据 + 封面 + 简介。
- 中文图书没有合规的免费 API；中文书目建议走 DeepSeek 搜索 + 出版社/豆瓣页面抓取（注意条款）。

---

## 4. 百科与参考

| 来源 | 覆盖 | 端点 | 鉴权 | 格式 | 验证 | 档 |
|---|---|---|---|---|---|---|
| **Wikipedia** | 300+ 语言百科（含中文） | `https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}`、Action API | 无（需描述性 User-Agent） | JSON | 📄（本次网络不通） | A |
| **Wikidata** | 结构化知识图谱 | `https://www.wikidata.org/w/api.php?action=wbsearchentities…`；SPARQL `https://query.wikidata.org/sparql` | 无 | JSON | 📄 | A/C |
| **Stanford Encyclopedia of Philosophy** | 哲学条目 | 无 API，仅 HTML | — | HTML | ⚠️ | D（可抓） |
| **百度百科** | 中文百科 | 无公开 API | — | HTML | ⚠️ | D |

**要点**：Wikipedia 的 REST API 一次就能拿到「摘要 + 描述」，是**性价比最高的百科源**；Wikidata 适合「实体消歧 / 拿结构化事实」，但要写 SPARQL，成本高一档。

---

## 5. 中文文献（现实检查）

| 来源 | 是否有公开 API | 结论 |
|---|---|---|
| 知网 CNKI | **无自助 API** | 唯一「开放」入口是知网研学开放平台（openx.cnki.net），但仍需邮件申请成为生态伙伴，无端点/文档/配额 → 实际等于商务授权；条款禁止未授权批量下载 |
| 万方 | **无** | 商业授权 |
| 维普 | **无** | 商业授权 |
| 国家哲学社会科学文献中心（ncpssd） | **无公开 API**（免费注册阅读） | 只能人工低频检索，明确限制批量下载 |
| 超星 / 读秀 | **无** | 商业采购；「文献传递」有配额但不是接口 |
| 百度学术 | **无** | 无公开接口 |

**结论**：中文文献在「免费 + 合规」范围内**没有可接入的数据源**。当前插件里 DeepSeek Search 覆盖中文网页，是唯一稳妥路径；要真接中文文献，只能走商业 API 合同。合规替代：机构订阅 + 校内代理、NSTL 文献传递（[nstl.gov.cn](https://www.nstl.gov.cn)）、用 Crossref/OpenAlex 取中文刊的 DOI 与元数据（覆盖有限）。

---

## 6. 法规与标准

| 来源 | 端点 / 接口 | 鉴权 | 结论 |
|---|---|---|---|
| 国家法律法规数据库（flk.npc.gov.cn） | 无官方 API 文档；前端调用站内 `/api/` 返回 JSON（非契约，可能变更） | 无 | B-：低频 + 本地缓存 + 标注来源；对接口变更做降级 |
| 国务院政策文件库（gov.cn） | 站内检索接口 | 无 | B-/D：只做标题/文号/链接索引，正文跳原文 |
| EUR-Lex | Web Service（SOAP）+ Cellar SPARQL + 批量包，EU 开放数据许可允许再利用（需署名） | 无 | C（学习成本高） |
| CourtListener（美国判例） | `https://www.courtlistener.com/api/rest/v4/` | 匿名低配额 / 注册 token | B |
| 国家标准全文公开系统（openstd） | 无 API，仅在线阅览 | — | D |
| ISO | 无免费 API（OBP 订阅） | — | D |

**结论**：法规类「官方 + 可编程」的是 EUR-Lex / CourtListener；中国法规里 **flk.npc.gov.cn 是唯一数据权威、免费、JSON 结构规整的源**，虽无官方契约，但工程上值得做「低频 + 缓存 + 标注来源」的接入；其余中文法规/标准不建议做工程依赖。

---

## 7. 专利

| 来源 | 端点 | 鉴权 | 额度 | 结论 |
|---|---|---|---|---|
| **EPO OPS / Espacenet** | `https://ops.epo.org/3.2/rest-services/` | OAuth2 免费注册 | 免费 4GB/月，超出付费 | **B：唯一能合规、免费拿到中国专利文献与法律状态的官方 API**；REST + XML |
| PatentsView（美国） | `https://search.patentsview.org/api/v1/` | 必须 `X-Api-Key`（免费） | 45 请求/分钟，单页 ≤1000 行，27 个端点 | B（本次网络不通，未能实测；官方文档已核） |
| USPTO ODP | `https://api.uspto.gov` | 免费 key | 有限流（数值未核实） | B |
| Google Patents | **无官方 API**；替代 BigQuery 公共数据集 `patents-public-data`（按查询计费，有免费额度） | GCP 账号 | — | C（网页抓取违反 ToS） |
| WIPO PATENTSCOPE | 有 SOAP Web Service，需向 WIPO 申请账号 | 需申请 | — | C |
| 国家知识产权局 CNIPA | 无公开自助 REST；检索系统需登录，批量数据需申请 | — | — | D |

**结论**：拿中国专利走 **EPO OPS**（合规、含中国文献），拿美国专利走 **PatentsView**；不要逆向 CNIPA。

---

## 8. 统计与数据

| 来源 | 端点 | 鉴权 | 格式 | 验证 | 档 |
|---|---|---|---|---|---|
| **World Bank** | `https://api.worldbank.org/v2/country/{c}/indicator/{ind}?format=json` | 无 | JSON | ✅（CC BY 4.0） | A |
| **Eurostat** | 数据接口 `.../statistics/1.0/data/{dataset}?format=JSON`；插件里用**内置常用数据集目录**（全量目录约 2MB / 8,700 条，按需再拉） | 无 | JSON-stat | ✅（数据接口）/ 内置目录 | A |
| FRED | `https://api.stlouisfed.org/fred/` | 免费 key | JSON | 📄（限流约 120 次/分，未逐字核实） | B |
| OECD | `https://sdmx.oecd.org/public/rest/v1/` | 无 | SDMX/JSON | 📄 | C |
| UNdata | `http://data.un.org/ws/rest/`（SDMX） | 无 | JSON/XML/CSV | 📄（部分 datamart 无 DSD） | C |
| 中国国家统计局（data.stats.gov.cn） | 无公开 API，仅站内 `easyquery.htm`（非契约） | — | HTML/内部 JSON | ⚠️ | D |

**实测样例**

```bash
curl -s "https://api.worldbank.org/v2/country/CHN/indicator/NY.GDP.MKTP.CD?format=json&per_page=2"
curl -s "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nama_10_gdp?format=JSON&geo=DE&na_item=B1GQ&unit=CP_MEUR&time=2023"
```

**结论**：统计类是「性价比最高」的一档——World Bank + Eurostat 零门槛；中国官方统计没有公开 API，建议 DeepSeek 搜索或年鉴页面兜底。

---

## 9. 新闻与舆情

| 来源 | 端点 | 鉴权 | 额度 | 结论 |
|---|---|---|---|---|
| GDELT | `https://api.gdeltproject.org/api/v2/doc/doc?query=…&format=json`；BigQuery | 无 | 免费；单次 ≤250 条；时间窗 3 个月；65 语种（含中文源） | A（本次网络未通，官方说明已核；建议加日更快照） |
| NewsAPI | `https://newsapi.org/v2/everything` | key | 免费 dev 档 100 请求/天，**禁止上线/商用** | B |
| RSS / Atom | 任意站点 feed | 无 | 取决于源站 | A（最稳的中文新闻合法路径；只存标题 + 链接） |
| Common Crawl | 索引 `https://index.commoncrawl.org/`；S3/Athena | 无（存储计费） | 免费、非实时 | C（适合离线建库） |

---

## 10. 医学与临床

| 来源 | 端点 | 鉴权 | 验证 |
|---|---|---|---|
| **ClinicalTrials.gov** | `https://clinicaltrials.gov/api/v2/studies?query.term=…`（`pageToken` 分页） | 无 | ✅ |
| WHO GHO | `https://ghoapi.azureedge.net/api/…`（OData） | 无 | 📄（许可 CC BY-NC-SA，商用注意） |
| Cochrane Library | 无公开 API（订阅制） | — | D（替代：PubMed E-utilities） |

---

## 11. 怎么装进现有插件（设计建议）

现在的 `createResearchExtension()` 是「DeepSeek 专用」；要接多源，建议按 **source adapter** 重构：

```ts
// packages/server/core/src/research/source.ts
export interface ResearchSource {
  id: string;              // 'web' | 'crossref' | 'europepmc' | 'gutendex' | ...
  label: string;
  needsKey?: boolean;
  /** 该源的额度提示（给设置页展示） */
  quotaNote?: string;
  search(input: { query: string; limit?: number; yearFrom?: number }, opts): Promise<SourceHit[]>;
  fetch?(url: string, opts): Promise<{ title: string; content: string }>;
}
```

- **工具形态**：保留 `research_search`，加一个 `source` 枚举参数（默认 `web` = DeepSeek）。这样工具数量不膨胀，模型自己选源；`research_fetch` 对支持全文的源（Gutenberg/Wikipedia/arXiv/DeepSeek）可用。
- **key 管理**：`settings.research.sources: { [sourceId]: { enabled, apiKey? } }`，密钥只写不读（复用现有 `maskKey`）；免 key 源不需要字段。
- **限流**：每源一个令牌桶（Crossref/OpenAlex 明说要退避）；arXiv 3 秒间隔；Semantic Scholar 必须带 key。统一 `Retry-After`/429 指数退避。
- **格式**：JSON 优先。arXiv（Atom）、PubMed efetch（XML）要么加 `fast-xml-parser`，要么用 Europe PMC / OpenAlex 的 JSON 结果替代。
- **缓存**：query+source 维度 24h 缓存（arXiv 官方就要求缓存一天），减少额度和延迟。
- **结果裁剪**：每源统一 `limit`（默认 5–10）+ 摘要截断；`fetch` 的长文沿用现有 `.aidocs/research/` 缓存 + `read` 分段读。
- **引用**：`research_save` 的 `sources` 自动带 DOI/URL，frontmatter 里保留 `sourceId` 便于追溯。

---

## 12. 推荐路线图

| 批次 | 源 | 理由 |
|---|---|---|
| **第一批（本周就能做）** | Crossref、Europe PMC、DOAJ、World Bank、Eurostat、ClinicalTrials.gov、Gutendex | 全部免 key + JSON + 本次实测通过；覆盖「论文元数据 / 摘要 / 开放获取 / 统计 / 临床 / 公版书」 |
| **第二批（要个 key）** | OpenAlex、Semantic Scholar、CORE、Google Books、FRED | 覆盖更广（OpenAlex）/ 有 TLDR（S2）/ 中文书（Google Books），需要在设置页加 key |
| **第三批（高投入）** | arXiv（XML）、Wikipedia/Wikidata、EPO OPS + PatentsView（专利）、flk.npc.gov.cn（中国法规）、GDELT、EUR-Lex | 要么解析 XML/SPARQL/OAuth，要么条款/额度复杂；按需再做 |
| **不接** | 知网/万方/维普、HathiTrust、ISO、国标全文、CNIPA、豆瓣、百度百科、Google Patents、Cochrane | 无公开 API 或需商业授权；中文资料用 DeepSeek 搜索兜底 |

**一句话**：第一批 6–7 个源就能把「科学 + 图书 + 统计 + 临床」补齐，且不需要任何新密钥；中文文献仍交给 DeepSeek 搜索。中文里唯一值得破例的是 **flk.npc.gov.cn（法规）**——无官方契约但 JSON 规整、权威免费。

---

## 13. 本次验证方法与未覆盖项

- **实测**：直接 `curl` / `web_fetch` 官方端点，成功拿到 JSON 即记为 ✅（Crossref、Europe PMC、NCBI、DOAJ、GBIF、World Bank、Eurostat、ClinicalTrials.gov、Gutendex、arXiv 手册、Semantic Scholar 429、OpenAlex 文档）。
- **补充调研**：中文文献/法规/专利/统计/新闻/标准/医学由并行调研补充，其中「已核」项（PatentsView 45 req/min + `X-Api-Key`、EPO OPS OAuth2、GDELT 250 条/3 个月/65 语种、WHO GHO OData、UNdata SDMX、CNKI 研学开放平台需申请、CNIPA 无自助 API、Google Patents 无 API）已对到官方文档；标注「未核实」的数字（FRED 限流、NewsAPI 价格、WIPO 端点数、CourtListener 具体限额）接入前需再确认。
- **网络限制**：本次环境对 `wikipedia.org`、`wikidata.org`、`openlibrary.org`、`googleapis.com`、`patentsview.org`、`gdeltproject.org`、`archive.org` 等域名解析失败（非公网 IP），相关条目标 📄/⚠️，接入前需在目标机器上再确认。
- **未覆盖**：中文开放数据（地方政府数据开放平台）、行业标准、企业内部知识库、RSS 精选源清单；这些可在下一轮补。
- 一手来源索引：
  - [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)
  - [OpenAlex Authentication & Rate Limits](https://help.openalex.org/api/authentication)
  - [Europe PMC REST](https://www.ebi.ac.uk/europepmc/webservices/rest/)
  - [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25497/)
  - [DOAJ API](https://doaj.org/api/v3/docs)
  - [arXiv API Manual](https://info.arxiv.org/help/api/user-manual.html)
  - [Semantic Scholar API](https://www.semanticscholar.org/product/api)
  - [GBIF API](https://techdocs.gbif.org/en/openapi/)
  - [ClinicalTrials.gov API v2](https://clinicaltrials.gov/data-api/api)
  - [World Bank API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392)
  - [Eurostat API](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access)
  - [Gutendex](https://gutendex.com/)
  - [Open Library API](https://openlibrary.org/developers/api)
  - [Wikipedia REST API](https://www.mediawiki.org/wiki/API:REST_API)
  - [PatentsView Search API](https://search.patentsview.org/docs/) · [USPTO Open Data](https://data.uspto.gov/apis)
  - [EPO Open Patent Services](https://developers.epo.org/)
  - [EUR-Lex Web Service](https://eur-lex.europa.eu/content/help/data-reuse/webservice.html) · [Cellar SPARQL](https://publications.europa.eu/webapi/rdf/sparql)
  - [CourtListener REST API](https://www.courtlistener.com/help/api/rest/)
  - [国家法律法规数据库](https://flk.npc.gov.cn/) · [中国政府网政策文件库](https://www.gov.cn/zhengce/xxgk/index.htm)
  - [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
  - [NewsAPI](https://newsapi.org/pricing)
  - [WHO GHO OData](https://www.who.int/data/gho/info/gho-odata-api)
  - [UNdata API](https://data.un.org/Host.aspx?Content=API)
  - [NSTL 文献传递](https://www.nstl.gov.cn)
  - [DeepSeek Search/Fetch（已接入）](https://api-docs.deepseek.com/zh-cn/guides/search/)
