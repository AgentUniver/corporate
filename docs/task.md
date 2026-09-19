# AgentUniver 项目完善执行计划 (task.md)

本任务清单严格依据 PRD v2.0 规格书制定，旨在系统化推进 AgentUniver 官方门户与智能体市场的商业化闭环、入驻通道、履约仲裁与工程质量落地。

---

## 任务进度全局总览

| 阶段 | 模块定位 | 规划任务数 | 已完成 | 状态 |
| :--- | :--- | :---: | :---: | :--- |
| **Phase 0** | 规范定型与冷启动基础设施 | 3 | 3 | [DONE] |
| **Phase 1** | 核心自定价与预估确认流 (Estimate -> Lock) | 4 | 4 | [DONE] |
| **Phase 2** | 双轨清结算与多渠道出金架构 (Global Payout) | 4 | 4 | [DONE] |
| **Phase 3** | Upwork 模式信任认证体系与信用资产沉淀 | 4 | 4 | [DONE] |
| **Phase 4** | 入驻网关与跨市场联邦协议端点落地 | 3 | 3 | [DONE] |
| **Phase 5** | 交付监管、自动化仲裁与工单系统增强 | 4 | 4 | [DONE] |
| **Phase 6** | 全站 DDS UI 规范审计与跨端响应式终验 | 3 | 3 | [DONE] |

---

## Phase 0: 规范定型与冷启动基础设施 (已基线化)

- [x] **TASK-001**: 升级 PRD 至 v2.0，明确定价哲学、双轮画像、双轨清结算与平台不自产 Agent 原则。
- [x] **TASK-002**: 导航架构权限治理，未登录状态严禁暴露 Orders 工单入口，保护企业资产隐私。
- [x] **TASK-003**: 页面级告警拦截组件 (PageAlert.astro) 全局挂载，替代原生 window.alert()。

---

## Phase 1: 核心自定价与预估确认流 (Estimate -> Accept -> Lock)

- [x] **TASK-101 (PRD)**: 在 PRD 2.2 节固化动态报价三要素模型公式与三段式报价确认机制规范。
- [x] **TASK-102 (UI)**: 在 `AgentHireModal.astro` 中改造派单交互，增加「实时费用估算面板」：
  - 显示 Base Compute 估算基准。
  - 推理轮次预估选择器 (1-3 轮 / 4-10 轮 / 10+ 深度反思)。
  - 加急系数选择器 (急迫 1.8x / 常规 1.0x / 闲时 0.6x)。
  - 自动计算并呈现「价格上限封顶 (Ceiling Cap)」。
- [x] **TASK-103 (Engine)**: 在 `src/lib/supabase.ts` 的 `TaskOrder` 数据结构中增加报价估算字段：
  - `estimatedComputeUsd`: number
  - `estimatedLoopSteps`: number
  - `urgencyMultiplier`: number
  - `priceCeilingUsd`: number
  - `actualCostUsd`: number
  - `costBreakdown`: 包含各要素与 `refundedRemainder` 差额返还明细
- [x] **TASK-104 (Validation)**: 编写前端与本地模拟器校验逻辑，超出预估报价 15% 时阻断结算并触发再次授权通知组件 (`hire-reauth-gate`)。

---

## Phase 2: 双轨清结算与多渠道出金架构 (Global Payout)

- [x] **TASK-201 (Contract)**: 确立以美元 (USD) 为全站唯一计价本位，出金支持法币与 L2 USDC 双轨，严禁 Uniswap 现货兑换以杜绝滑点。
- [x] **TASK-202 (Schema)**: 扩展 `TaskOrder` 接口与出金配置：
  - 支持 `payoutRail: 'fiat_stripe' | 'fiat_wise' | 'fiat_payoneer' | 'crypto_usdc'`。
  - 支持 `payoutAddress` (EVM L2 地址或法币结算银行账号/邮箱/ID)。
  - 支持 `payoutStatus: 'pending' | 'escrowed' | 'settled' | 'failed'`。
- [x] **TASK-203 (UI)**: 在创建/入驻表单 (`/create`) 中增加「出金偏好与收款设置 (Payout Preferences)」配置项：
  - 支持选择 Stripe Connect / Wise / Payoneer / L2 USDC (Base/Arbitrum)。
  - 动态切换账户标识占位符并提示无滑点结算与最低出金阈值 (20 USD)。
- [x] **TASK-204 (Escrow)**: 完善 `src/lib/supabase.ts` 中的对账函数 `generateOrderAccountingLedger`，输出符合 PRD 规范的 10% 撮合服务费与 90% 净出金机器可读 JSON 记录。

---

## Phase 3: Upwork 模式信任认证体系与信用资产沉淀

- [x] **TASK-301 (Data Model)**: 在 Agent 数据结构中引入 4 级认证阶梯字段：
  - `trust_tier: 'tier_0_new' | 'tier_1_rising' | 'tier_2_top_rated' | 'tier_3_certified'`。
  - `acceptance_rate`: number (百分比)。
  - `total_orders_completed`: number。
  - `dispute_count`: number。
- [x] **TASK-302 (Marketplace UI)**: 在 `src/pages/marketplace/index.astro` 的卡片中新增认证徽章视觉渲染：
  - `AU Certified`: 金色认证徽章与优先置顶权重。
  - `Top Rated`: 极光蓝徽章，标明完单率与评分。
  - `Rising Talent`: 翡翠绿新手优选标签。
- [x] **TASK-303 (Sorting)**: 市场排序器增加「认证等级优先 (Trust Tier First)」与「好评率优先」排序项。
- [x] **TASK-304 (Review Gate)**: 任务完成后增加多维评分结构化反馈表单（任务清晰度、交付质量、时效、性价比，1-5 星级）。

---

## Phase 4: 入驻网关与跨市场联邦协议端点落地

- [x] **TASK-401 (UI)**: `/create` 页面扩展为三列布局，增加「Social & Federated Ingress」入口与互动规范视图。
- [x] **TASK-402 (API Mock / Integration)**: 搭建 `/api/v1/ingress/social` 服务端点 (Astro API Route)：
  - 支持接收标准 Agent Manifest JSON Payload。
  - 校验 DID 签名与社媒 Proof 标识。
  - 触发 Canary 冒烟拨测，达标后自动写入 Agent 索引库。
- [x] **TASK-403 (Federation Specs)**: 编写 Virtuals、Fetch.ai 与 ElizaOS 外部协议向 ACP 2.0 映射的数据转换器模块骨架。

---

## Phase 5: 交付监管、自动化仲裁与工单系统增强

- [x] **TASK-501 (UI)**: 全局 `OrdersDrawer.astro` 抽屉上线，支持工单实时状态追踪与交付物预览。
- [x] **TASK-502 (Mechanism)**: 确立自动化证据链仲裁模型，严禁引入人工介入与 DAO 主观投票，保障争议秒级定谳。
- [x] **TASK-503 (Validator)**: 交付数据包 Schema 校验器：
  - 对交付 JSON/CSV 载荷进行字段级契约检查。
  - 生成交付内容不可篡改的 SHA-256 数字指纹。
- [x] **TASK-504 (Dispute Engine)**: 完善 `disputeOrder` 方法：
  - 当需求方在 24-72 小时内发起争议时，依据平台探针监控日志与 Schema 校验报告自动下达判决。

---

## Phase 6: 全站 DDS UI 规范审计与跨端响应式终验

- [x] **TASK-601**: Marketplace 页面按 DDS UI SOP 实施受控分页 (PAGE_SIZE = 6)，消灭多余图表与超长列表。
- [x] **TASK-602**: 全局网格竖屏与移动端响应式样式重构，确保无水平滚动条与断层。
- [x] **TASK-603**: 全站零 Emoji 纪律与代码洁净度最终回归扫描，保障 `npx astro check` 零错误、零警告。

---

## Phase 7: Post-Flight 记忆注入与远端发布闭环

- [x] **TASK-701**: 执行本地 Git Commit 并通过 [SECURITY-GATE] 门禁放行，成功推送 3 个 commit 至 Gitea 远端主分支 (`5debcd4..4bbab35`)。
- [x] **TASK-702**: 根据 `.agent/workflows` 核心规范生成工作流治理记忆，调用 `memory_mgr.py` 成功注入 PostgreSQL `agent_Exclusive` (`ag_infinite_memory`)。
- [x] **TASK-703**: 提炼本轮治理与仲裁交付 Post-Flight 里程碑结构化摘要，注入 PostgreSQL 记忆库完成闭环。

