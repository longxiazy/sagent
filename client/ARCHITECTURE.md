# Client 前端架构指南

面向第一次接触本项目前端的人。读完后你能：
- 看懂 `src/App.jsx` 这份根组件在干什么；
- 知道每个 hook 和组件的职责边界，添加功能时知道往哪儿放；
- 理解一些非典型设计（agent SSE 重连、可见性兜底等）背后的原因。

不要求你之前写过 React，但读过任何带状态的 UI 代码（Vue / SwiftUI / Compose 都行）会更容易上手。

---

## 0. 五分钟 React/JSX 速通

如果你已经熟 React，跳到 §1。

### 组件 = 函数
React 里"组件"就是一个返回 HTML 模板的 JS 函数。`App` 是组件，`<ChatPane>` 也是。

```jsx
<ChatPane messages={msgs} />
// 等价于
ChatPane({ messages: msgs })
```

大小写规则：**大写开头** = 自定义组件、**小写开头** = 原生 HTML 标签（`<div>` / `<span>`）。

### JSX = JS 里写 HTML
`return (<div>...</div>)` 不是字符串，是 JS 表达式，编译成 `React.createElement(...)`。HTML 里穿插 JS 用 `{}`：

```jsx
<span>{messages.length} 条消息</span>     {/* 插值 */}
<button disabled={locked}>...</button>     {/* 属性绑定 */}
{showHero && <HeroScreen />}                {/* 条件：showHero 真才渲染 */}
{messages.map(m => <Message key={m.id} ... />)}  {/* 列表 */}
condition ? <A/> : <B/>                     {/* 三元 */}
```

### 状态 = `useState`，副作用 = `useEffect`

```js
const [input, setInput] = useState('');
// 声明一个会变的值；改它必须 setInput('xxx')

useEffect(() => {
  // deps 变化时执行
  return () => { /* 清理 */ };
}, [deps]);
```

任何 `set*` 调用都会触发组件**重新执行整个函数**（重新渲染）。

### `useRef` = 不触发渲染的"挂钩存空位"
```js
const ref = useRef(null);
ref.current = 'foo';      // 改它不会重渲染
ref.current               // 读取
```
常用来存 DOM 节点引用、定时器句柄、AbortController 等"我需要存但 UI 不依赖"的东西。

### 事件绑定
```jsx
<button onClick={() => doSomething()}>...</button>  {/* ✓ 函数引用 */}
<button onClick={doSomething()}>...</button>         {/* ✗ 立即执行 doSomething，把返回值当回调 */}
```

---

## 1. 顶层目录

```
client/src/
├── App.jsx              ← 根组件：状态装配 + 顶层 effects + JSX 拼装
├── App.css              ← 全局样式
├── main.jsx             ← 入口，挂载 <App> 到 #root
├── notifications.js     ← 桌面通知 + service worker
├── api/                 ← 后端接口封装（streams.js 等）
├── components/          ← UI 组件（叶子 + 容器）
├── hooks/               ← 自定义 hook（状态管理、副作用、业务流程）
├── utils/               ← 纯函数（constants / format / markdown / random）
└── data/                ← 静态前端数据（suggestions 等）
```

**职责约定**：

| 目录 | 做什么 | 不做什么 |
|---|---|---|
| `components/` | 接 props 渲染 UI；触发 callback | 不持有业务状态、不发请求 |
| `hooks/` | 持有状态、跑 effect、发请求 | 不直接写 JSX |
| `utils/` | 纯函数 | 不依赖 React |
| `data/` | 静态数据 | — |

---

## 2. App.jsx 骨架

```
┌───────────────────────────────────────────────────────────────┐
│ 1-51    import：组件、hook、工具函数                            │
│ 53-99   辅助函数：附件拼接、模型 ID 清洗、trace 模型提取          │
├───────────────────────────────────────────────────────────────┤
│ 101     function App()  ← 应用根组件                           │
│                                                               │
│ 101-226 ① 状态声明区                                           │
│ 228-258 ② 启动初始化：拉后端模型列表                            │
│ 262-266 ③ 同步浏览器地址栏颜色（useThemeColorSync）             │
│ 268-470 ④ Agent SSE 重连 effect（最复杂的一块）                 │
│ 479-555 ⑤ 可见性兜底（手机后台漏事件的补救）                    │
│ 557-633 ⑥ 零碎 effects：聚焦/滚动/建议/textarea 自适应高度      │
│ 635-641 ⑦ 卸载清理                                            │
│                                                               │
│ 643-739 ⑧ 业务 handler / hook：session / project / agent /附件 │
│ 741-786 ⑨ handleSubmit / handleKeyDown                        │
│ 788-847 ⑩ 派生数据 + 工具栏 slot 变量                          │
│                                                               │
│ 849-1015 ⑪ return (...)：实际渲染的 JSX                       │
└───────────────────────────────────────────────────────────────┘
```

`App` 这个函数会被 React **反复调用**——任何 state 变了就调一次。①-⑩ 区每次渲染都重跑（`useEffect` 内部按依赖触发），⑪ 是当次渲染要画的东西。

---

## 3. 区域详解

### ① 状态声明（101-226）

| 状态 | 来源 | 用途 |
|---|---|---|
| `sessions / activeSession / messages` | `useChatSessions()` | 全部会话 + 当前会话 + 消息列表 |
| `projects / activeProjectId` | `useProjects()` | 项目列表 + 当前激活项目 |
| `availableModels` | useState | 后端可用模型列表（初始为空，加载后替换） |
| `modelsLoaded` | useState | 区分"尚未拿到后端列表"和"真实列表为空"，避免启动时误清理用户已选多模型 |
| `input` | useState | 输入框文字 |
| `useAgentRun()` 一大堆 | hook | Agent 运行态：`agentRunning / agentTrace / pendingApproval / ...` + 一堆 ref |
| `notifyPerm` | useState | 桌面通知权限：`default / granted / denied` |
| `agentMemory` | `usePersistentState` | Agent 记忆开关（应用级偏好） |
| `selectedAgentModels / agentStrategy` | `useProjectScopedState` | Agent 模型选择与策略（按项目分桶） |
| `showReset / showSessions / showMemoryPanel` | useState | 各种弹窗/抽屉的开关 |
| `bottomRef / textareaRef` | useRef | 聊天底部 DOM（滚动用）、textarea DOM（focus + 高度计算） |

**关键区分**：
- `useState` 的值用 `set*` 改，会重渲染。
- `useRef` 的值用 `.current` 读写，**不会**重渲染。

### ② 拉后端模型列表（228-258）

挂载时 `apiFetch('/api/models')`：
1. 更新 `availableModels`；
2. 顺手扫一遍历史会话，清除已经下线的 `model/modelsUsed` 引用，不自动替换成首个可用模型；
3. 设 `modelsLoaded = true`，让"清理用户多选模型"effect 才敢动手。Agent 运行前仍要求用户在模型选择器里手动选择至少一个模型。

### ③ `useThemeColorSync`（262-266）

把 `<meta name="theme-color">` 改成当前主背景色，让手机浏览器顶部地址栏跟着变色。逻辑全在 hook 里。

### ④ Agent SSE 重连 effect（268-470）⭐

**场景**：用户开了 Agent 任务，**刷新了页面**。后端还在跑，UI 必须接回来。

**流程**：

```
1. GET /api/agent/active        → 有没有跑着的？
2. 没有就退出；有就：
   - 恢复前端运行态（agentRunning / runId / startedAt 等）
   - 显示"重连了"提示（reconnectedRun = true）
   - 临时塞一条占位消息进会话（避免覆盖用户其他会话内容）
3. GET /api/agent/stream/:runId → 建 SSE 流
4. 用 getReader() 一行行手读：
   - approval_required → 弹审批框
   - question_required → 弹问询框
   - rollback          → 砍掉 trace 里超过某步的事件
   - done              → 把"正在执行…"那条消息替换为最终答案
   - error             → 收掉 running 状态
   - 其他              → 去重后追加到 agentTrace
```

**几个值得注意的点**：
- `AbortController` 是"我可以中途取消这个网络请求"的句柄；effect 的 `return () => controller.abort()` 是清理函数，组件卸载或 effect 重跑前会调用。
- 空依赖 `[]` 表示这个 effect 只在挂载时跑一次——故意的，重连只应该做一次。
- `updateActiveSession` 不能依赖闭包里的 `activeSession`，因为回调可能在很久之后触发；它每次从最新 `chatState` 里拿 `activeSessionId`。
- SSE 重连时同一批事件可能被回放两次，所以追加前按 `type / step / stage / model` 去重。

### ⑤ 可见性兜底（479-555）

**场景**：手机切到后台时浏览器会冻结 JS、节流网络，SSE reader 可能漏掉 `done` / `error`。

**做法**：监听 `visibilitychange`，切回前台时如果 UI 还以为 agent 在跑，就调 `fetchAgentTrace(rid)` 拉持久化的 trace。如果里面已经有终止事件（`done` / `error`），就把答案灌回去、收掉 running 状态、关掉所有挂起弹窗——避免"任务已结束但 UI 一直转圈"。

### ⑥ 零碎 effects（557-633）

- **挂载聚焦**：进页面自动 focus 输入框。
- **会话切换同步 trace**：切到另一个会话时，把那个会话的 agentTrace 拉出来（去重后写入），并把"上次 agent 任务原文"记到 ref 里供 rollback 重试用。
- **快捷键**：`Cmd/Ctrl+Shift+E` 折叠面板、`Cmd/Ctrl+Shift+M` 切记忆面板。
- **自动滚动**：`messages / activeSession.id / agentTrace` 变化时滚到底。
- **建议数据刷新**：从后端拉取推荐任务；提交任务后刷新"最近使用"。
- **textarea 自适应高度**：根据 `input` 长度计算，最高 144px。

### ⑦ 卸载清理（635-641）

组件卸载（页面关闭、导航）时：
- 中止 Agent 的网络流；
- 拒绝挂起的审批 Promise（避免悬挂的 `await`）。

### ⑧ 业务 handler / hook（643-739，843-847）

| Hook | 返回 | 干嘛 |
|---|---|---|
| `useSessionHandlers` | 5 个 handler | 新建/选择/删除/清空/重置 |
| `useProjects` | 项目列表 + CRUD/切换函数 | 项目级会话、记忆、文件根隔离 |
| `useAgentTransport` | `sendAgentTask / stopAgent / handleRollback / handleApprovalDecision` | Agent 的全部操作 |
| `useAttachments` | 附件列表 + 上传/消费/删除函数 | 输入栏图片附件上传与任务文本拼接 |
| `useQuestionSubmit` | `handleSubmit / handleSkip` | QuestionDialog 的回答提交（靠近 JSX 前实例化） |

**为什么抽 hook**：把"一坨相关的状态+函数"打包，避免 App.jsx 里全是 200 行的内联函数。

### ⑨ 提交 + 快捷键（741-786）

```js
handleSubmit  // 按发送：校验输入/附件/模型 → 拼任务文本 → 调 sendAgentTask
handleKeyDown // 桌面按 Cmd/Ctrl+Enter 发送；手机不拦截（要换行）
```

### ⑩ 派生数据 + slot 变量（788-847）

派生数据：
```js
suggestions = useMemo(...)  // 依赖不变就用缓存值，避免每次渲染重洗牌
```

**Slot 变量**（重要模式）：

```jsx
const modelSelect = <ModelSelector ... />
const sendButton = <SendButton ... />
const attachButton = <AttachButton ... />
const attachmentBar = <AttachmentBar ... />
```

React 里可以把一段 JSX 表达式**赋给变量**，之后多处插入。`modelSelect` 在 hero 首屏和 layout header 共用，`sendButton / attachButton / attachmentBar` 在 hero 与聊天输入区共用——写成变量后口径一致：

```jsx
<HeroScreen toolbarSlots={{ modelSelect, sendButton, attachButton }} attachmentBar={attachmentBar} />
<AppHeader  modelSelect={modelSelect} />
<ChatPane   sendButton={sendButton} attachButton={attachButton} attachmentBar={attachmentBar} />
```

业内叫 **slot pattern** / **render prop**——把 JSX 当数据传。

### ⑪ 最后的 return JSX（849-1015）

骨架：

```jsx
<ErrorBoundary>                     {/* 顶层：任何子组件崩了在这兜住 */}
  <div className="app-shell">

    <SessionSidebar>                {/* 左侧会话列表抽屉 */}
      <SessionList .../>
    </SessionSidebar>

    <div className="main-area">

      {/* 通知权限 banner，三个条件都满足才显示 */}
      {agentRunning && notificationsSupported() && (notifyPerm 非 granted) && (
        <NotificationBanner .../>
      )}

      {/* 首屏「+ 新建」浮按钮，只在 hero 时显示 */}
      {showHero && <button>+ 新建</button>}

      {/* 主体二选一：首屏 vs 已开始会话 */}
      {showHero ? (
        <HeroScreen .../>                {/* brand + 输入卡 + 推荐列表 */}
      ) : (
        <div className="layout">         {/* 已开始：banner + header + 主体 */}
          {reconnectedRun && agentRunning && <div>重连提示</div>}
          <AppHeader .../>
          <div className="layout-body">
            <AgentPane .../>                           {/* Agent 面板 */}
            {messages.length > 0 && <ChatPane .../>}   {/* 聊天面板 */}
          </div>
        </div>
      )}
    </div>

    {/* 三个全局对话框：满足条件时浮在最上层 */}
    <ApprovalDialog .../>
    <QuestionDialog .../>
    {showReset && <ResetDialog .../>}
    {showSettings && <SettingsDialog .../>}
  </div>
</ErrorBoundary>
```

JSX 习惯：
- `condition && <X/>` — 条件渲染，假时整段为 `false`，React 不渲染任何东西
- `condition ? <A/> : <B/>` — 二选一
- `array.map(item => <X key={...} .../>)` — 渲染列表，**`key` 必须给**（重排时复用 DOM 节点）
- `onClick={() => fn()}` — 事件绑定必须是函数引用

---

## 4. 数据流总览

```
后端 SSE / fetch
       │
       ▼
   effect 里更新 state
       │
       ▼
   state 变化触发重新渲染
       │
       ▼
   子组件收到新 props
       │
   ┌───┴───┐
   │  渲染  │ ←─────────────┐
   └───┬───┘                │
       │ 用户点击/输入       │
       ▼                    │
   handler → setState ──────┘  (又一轮)
```

App.jsx 主要做三件事：
1. **持有所有需要在子组件间共享的状态**（messages、agentTrace、pendingApproval 等）
2. **处理跨组件的 effect**（重连、可见性兜底、滚动、聚焦）
3. **拼装组件树**，state 通过 props 传下去，事件通过 callback prop 抛上来

子组件（HeroScreen、AppHeader、ChatPane 等）只负责"拿到 props 就渲染对应的 UI"，自己不持有业务状态。

这就是 React 经典的 **状态上提 + props 下传 + 事件上抛** 模式。

---

## 5. 组件 / Hook 索引

### 组件

| 文件 | 职责 |
|---|---|
| `components/AgentPane.jsx` | Agent 运行时的左侧布局容器（面板 + 分隔条） |
| `components/ChatPane.jsx` | 聊天消息列表 + 底部输入栏 |
| `components/SessionSidebar.jsx` | 左侧会话列表抽屉容器（移动端覆盖、桌面常驻） |
| `components/ErrorBoundary.jsx` | 顶层错误边界 |
| `components/ResizeDivider.jsx` | Agent / Chat 分隔条，可拖拽调整宽度 |
| `components/MessageContent.jsx` | 单条消息内容渲染（markdown + 高亮） |
| `components/CopyButton.jsx` | 复制到剪贴板按钮 |
| `components/AppHeader.jsx` | 已开始会话后的顶部 header |
| `components/HeroScreen.jsx` | 首屏（brand + 输入卡 + 推荐列表） |
| `components/ModelSelector.jsx` | Agent 多模型选择（多选 tag + 排序 + 策略） |
| `components/SendButton.jsx` | 发送/停止按钮 |
| `components/AttachButton.jsx` | 附件选择按钮 |
| `components/AttachmentBar.jsx` | 已上传附件条 |
| `components/SuggestionsList.jsx` | 推荐任务/问题列表 + "换一组" |
| `components/NotificationBanner.jsx` | 桌面通知权限提示 banner |
| `components/ScreenshotImages.jsx` | Agent trace 中嵌入的截图 |
| `components/dialogs/ResetDialog.jsx` | 清空会话确认弹窗 |
| `components/dialogs/SettingsDialog.jsx` | 设置弹窗（记忆开关等） |
| `components/dialogs/ApprovalDialog.jsx` | Agent 操作审批弹窗 |
| `components/dialogs/QuestionDialog.jsx` | Agent 反向提问弹窗 |
| `components/dialogs/ProjectDialog.jsx` | 项目创建/编辑弹窗 |
| `components/session/SessionList.jsx` | 会话列表项 |
| `components/session/MemoryPanel.jsx` | Agent 记忆查看面板 |
| `components/session/ProjectSwitcher.jsx` | 项目切换/管理入口 |
| `components/agent/AgentPanel.jsx` | Agent trace 主面板 |
| `components/agent/StepCard.jsx` | 单模型步骤卡片 |
| `components/agent/TraceItem.jsx` | trace 事件渲染兜底 |
| `components/agent/ModelPlanCard.jsx` | 单个模型的执行卡片 |
| `components/agent/ModelPlanGroup.jsx` | 多模型并行时的卡片组 |
| `components/markdown/MarkdownBlock.jsx` | Markdown 渲染 |
| `components/markdown/CodeBlock.jsx` | 代码块（带语法高亮 + 复制） |
| `components/markdown/ThinkBlock.jsx` | `<think>` 推理过程折叠块 |

### Hook

| 文件 | 职责 |
|---|---|
| `hooks/useChatSessions.js` | 会话列表 + 当前选中 + 消息持久化 |
| `hooks/useProjects.js` | 项目列表 + 当前项目 + 项目 CRUD |
| `hooks/useAgentRun.js` | Agent 运行时的全部状态 + refs |
| `hooks/usePersistentState.js` | `useState` 的 localStorage 版 + 按项目分桶状态 |
| `hooks/useResponsiveLayout.js` | 窄屏/宽屏切换时的侧栏可见性 + 面板宽度恢复 |
| `hooks/useThemeColorSync.js` | 同步 `<meta theme-color>` |
| `hooks/useKeyboardShortcuts.js` | 全局快捷键 |
| `hooks/useSessionHandlers.js` | 新建/选择/删除/清空/重置 |
| `hooks/useAgentTransport.js` | Agent 的全部操作 |
| `hooks/useQuestionSubmit.js` | QuestionDialog 的 submit/skip 回调封装 |
| `hooks/useAttachments.js` | 附件上传、删除、消费 |
| `hooks/useIsMobile.js` | 移动端媒体查询判断 |

---

## 6. 常见任务怎么做

### 加一个新的 UI 组件
1. 在 `components/` 下建文件，纯 props → JSX。
2. 在 App.jsx（或父组件）里 import + 渲染，把所需 state / handler 当 props 传下去。
3. 不要在组件里 `useState` 持有跨组件共享的业务状态——上提到父组件或 hook。

### 加一个新的状态
1. 跨多个子组件共享？放 App.jsx 顶部，用 `useState`。
2. 跨多个不相关的组件共享 + 持久化？写成自定义 hook（参考 `usePersistentState`）。
3. 只在一个组件里用？就放那个组件里。

### 加一个新的副作用
1. 想清楚依赖：什么变了才该触发？
2. 写 `useEffect(() => { ... return cleanup }, [deps])`。
3. 如果副作用很大、跟某个特定状态紧密耦合，考虑抽成自定义 hook。

### 加一个新的后端接口
1. 在 `api/` 下加封装函数（例如 `streams.js`、`uploads.js`，或新建 `api/foo.js`）。
2. 让 hook / effect 调它，不要在组件里直接 `fetch`。

---

## 7. 反模式（别这么干）

- **在子组件里持有跨组件共享的业务状态**——会导致状态分散、prop drilling 失控。
- **在 JSX 里直接调用函数**：`onClick={fn()}` 立即执行；应该是 `onClick={fn}` 或 `onClick={() => fn(arg)}`。
- **`useEffect` 依赖数组遗漏**——React 会报警告。如果故意要遗漏，写 `// eslint-disable-next-line react-hooks/exhaustive-deps` 并写注释解释为什么。
- **`useRef.current` 在渲染期间读写**——结果是不可预测的；用 `useState` 或 effect。
- **改 state 时直接改原对象**：`messages.push(...)` ✗，要 `setMessages([...messages, newMsg])` ✓。
- **`map` 不给 `key`**：列表更新时 React 不知道哪个是哪个，DOM 复用会出 bug。
