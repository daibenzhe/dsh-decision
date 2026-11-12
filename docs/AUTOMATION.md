# 决策能力接入自动化：设计文档

> 目标：把 `decision` 的能力从「对话里的工具」抽象成一个可编程接口，供定时任务、外部事件、子代理三种自动化场景直接调用。

---

## 1. 现状与问题

当前插件的能力分布：

| 形态 | 入口 | 是否可用于自动化 |
|---|---|---|
| 工具 `decision` | 模型在对话中调用 | 间接——需要一次模型轮次 |
| 指令 `/decision` | 用户在输入框执行 | 否——需要人 |
| `reasoningMode: auto` | `agent/pre-step` 注入上下文 | 半自动——仍依赖对话 |
| `runDecision()` | 内部函数 | 否——未导出 |

**核心问题**：`runDecision()` 已经是一个干净的、无副作用的纯执行函数，但它被封闭在插件内部，且依赖 `ctx` 查找凭据。自动化任务无法拿到它。

因此第一步不是加新功能，而是**把已有的执行核心暴露成 Service**。

---

## 2. 目标接口

### 2.1 Service 形状

```js
// ctx.decisionModels —— 可编程接口
{
  // 单次判定
  async classify(request, signal?): Promise<DecisionOutcome>
  // 批量（一次请求多条目，或多次请求）
  async classifyBatch(request, signal?): Promise<DecisionBatchOutcome>
  // 后端能力查询（供调用方决定用哪个 provider）
  async capabilities(): Promise<ProviderCapabilities>
}
```

### 2.2 `classify`

```ts
interface ClassifyRequest {
  /** 共享证据：字符串或 JSON state */
  input: string | JsonValue;
  /** 一个或多个问题 */
  questions: DecisionQuestion[];
  /** 后端，缺省用插件配置的 defaultProvider */
  provider?: "jev" | "google" | "openai";
  /** 路由偏好 */
  source?: "openrouter" | "typesafe" | "google" | "openai";
  /** 置信度阈值：低于此值时 outcome 标为 uncertain，调用方据此分流 */
  minConfidence?: number;
}

interface DecisionOutcome {
  ok: true;
  provider: string;
  source: string;
  model: string;
  answers: Record<string, NormalizedAnswer>;
  /** 任一答案未达 minConfidence，或出现 refusal */
  uncertain: boolean;
  usage: JsonValue | null;
  /** 用于审计与重放的稳定指纹 */
  fingerprint: string;
} | {
  ok: false;
  error: { code: DecisionErrorCode; message: string };
}
```

关键设计点：

- **`uncertain` 标志**：自动化场景最需要的是「这个判断够不够可信，要不要转人工」。把阈值判断内置，调用方不必自己读概率。
- **`fingerprint`**：输入 + 问题的哈希，可用于去重（同一事件被投递两次）和缓存。
- **永不抛异常**：返回判别联合，自动化流程不会因为一个决策失败而崩溃。

### 2.3 `classifyBatch`

两种语义，需显式区分：

```ts
interface ClassifyBatchRequest {
  /** 模式 A：同一组问题，多个独立条目 */
  mode: "items";
  items: Array<{ id: string; input: string | JsonValue }>;
  questions: DecisionQuestion[];

  // 或模式 B：同一份证据，多个问题（即单次请求多问）
  // mode: "questions"  — 等价于 classify，不单独提供

  /** 并发上限，默认 4 */
  concurrency?: number;
  /** 失败条目的处理：继续或中止，默认 continue */
  onError?: "continue" | "abort";
}

interface DecisionBatchOutcome {
  results: Array<{ id: string } & DecisionOutcome>;
  /** 汇总统计，便于自动化任务记录 */
  summary: { total: number; ok: number; uncertain: number; failed: number };
}
```

注意：**模式 B（一份证据多问题）已经由单次 `classify` 覆盖**——一次请求本来就能问多个问题。所以 `batch` 只针对「多个独立条目」，这正是批量分类的场景。

---

## 3. 三种场景的接入方式

### 3.1 定时任务

定时任务当前通过 `schedule_create` 投递一段 prompt 到某个会话。有两种接法：

**接法 A（推荐）：任务 prompt 里指示模型调用工具**

无需改插件。定时任务的 prompt 写成：

```
读取 data/tickets.json，对每条工单判断应分给哪个团队。
先用 decision 工具批量判断，再按结果分组输出。
```

优点：零改动。缺点：仍消耗模型轮次。

**接法 B：Service 直连**

若定时任务的产出不需要模型参与（纯分类分流），可以由一个独立的自动化插件在 `schedule` 触发时直接调 `ctx.decisionModels.classifyBatch()`，把结果写文件。

这要求 `decisionModels` 是真正的 Host Service，而不是闭包函数——**这正是第 2 节的目的**。

### 3.2 外部事件触发

`webhookRuntime.register({ id, kind, run })` 的 `run` 回调签名：

```ts
run(delivery, signal): WebhookSessionRequest | null | Promise<WebhookSessionRequest | null>
```

它返回「是否要为这个事件创建一个会话」。这正好是前置判断的位置：

```js
ctx.webhookRuntime.register({
  id: "ticket-triage",
  kind: "ticket-created",
  async run(delivery, signal) {
    const outcome = await ctx.decisionModels.classify({
      input: delivery.event,
      questions: [{
        name: "priority",
        type: "score",
        instructions: "How urgent is this issue?",
        levels: ["backlog", "this week", "blocking"],
      }],
    }, signal);

    // 低优先级事件不建会话，静默归档
    if (!outcome.ok || outcome.uncertain) return null;
    const priority = outcome.answers.priority.score;
    if (priority < 1.5) return null;

    return {
      workspacePath: "/path/to/ws",
      title: `Urgent: ${delivery.event.title}`,
      prompt: `Handle this urgent ticket:\n${JSON.stringify(delivery.event)}`,
      agentPreset: "standard",
      permissionPreset: "default",
    };
  },
});
```

**这是最贴合的场景**：决策模型作为「要不要惊动 agent」的廉价闸门，过滤掉绝大多数事件。

### 3.3 子代理批量处理

子代理由父 agent 通过 `subagent` 工具创建，其 `prompt` 是文本。两种接法：

**接法 A**：父 agent 先批量判断，把结论写进子代理的 prompt

```
以下 20 条工单已判定为「账单」类，请逐条处理：...
```

**接法 B**：子代理自己调工具

每个子代理的 prompt 里指示「先用 decision 判断类别，再处理」。

**推荐 A**：批量判断放在父层做一次，子代理只负责执行。理由是一次 `classifyBatch` 可以覆盖全部条目，比每个子代理各自调用更省 token，也更一致。

---

## 4. 实施步骤

### 阶段 1：抽出 Service（必做）

1. 在 `index.js` 中新增 `DecisionModelsService`（`extends Service`，名字 `decisionModels`）
2. 把现有 `runDecision()` 移进去，保持行为不变
3. 工具、指令、`auto` 模式改为调用 `this.ctx.decisionModels.classify()`
4. **这一步不改变任何外部行为**，纯重构 + 暴露

风险：`tools`、`commands`、`systemPrompt` 都依赖 `inject`，新增 Service 后需确认激活顺序。Service 自己 `inject: ["credentials"]`。

### 阶段 2：增强判定结果（建议）

1. 增加 `minConfidence` 参数与 `uncertain` 标志
2. 增加 `fingerprint`（输入 + 问题的稳定哈希）
3. 增加 `classifyBatch`（items 模式 + 并发控制）

### 阶段 3：场景接线（按需）

1. 定时任务：先在 prompt 层用工具版（零改动）
2. 外部事件：写一个示例自动化 bundle，演示 webhookRuntime + classify 的闸门模式
3. 子代理：在父层用 `classifyBatch`，结果写入子代理 prompt

---

## 5. 需要决策的问题

| 问题 | 选项 | 建议 |
|---|---|---|
| Service 是否应缓存结果？ | 不缓存 / 按 fingerprint 缓存 | **先不缓存**。决策模型便宜（每次约 $0.00002），缓存引入失效问题不值得 |
| 批量失败如何处理？ | 全中止 / 部分成功 | **部分成功**，失败条目带 error，自动化任务按 summary 决定后续 |
| 是否支持图片/音频输入？ | 仅文本 / 全媒体 | **支持**，`input` 已经是 `state` 形状，媒体部件透传即可，格式校验已有 |
| `uncertain` 阈值由谁定？ | 插件全局配置 / 每次调用传 | **每次调用传**，`minConfidence` 可选。不同场景容忍度不同 |
| 是否需要事件通知？ | 不通知 / `decision/answered` 事件 | **先不做**。等有明确消费者再加 |

---

## 6. 一个必须澄清的边界

**决策模型不是 agent。** 它返回概率，不做多步推理、不调用工具、不给解释。自动化场景里它的正确位置是：

- ✅ 前置闸门（要不要处理、分给谁、优先级如何）
- ✅ 批量打标（一次处理几百条）
- ✅ 阈值判断（置信度低于 X 转人工）
- ❌ 代替 agent 完成任务（它做不到）

因此这份设计的核心不是「让决策模型执行任务」，而是「在自动化流程的关键分叉点上，用便宜且可校准的判断替代昂贵的模型轮次或写死的规则」。

---

## 7. 下一步

建议先做**阶段 1**，因为它是纯重构，不改变现有行为，但把能力变成真正可复用的东西。做完之后，三种场景都能接入，且阶段 2、3 可以按实际需要推进。

需要我按这个设计实施阶段 1 吗？
