/**
 * 技能管理器的浏览器半边（界面重做版）。
 *
 * 结构（对照需求）：
 *
 *   - 左上三个竖向入口：**已安装** / **技能市场** / **回收站**；右上 **设置** / **刷新**；
 *   - 已安装页：顶部「技能目录」下拉（= 扫描根）筛选 + 「导入本地」+「刷新」；
 *     主体是按扫描根归类的**卡片网格**，每行 6 张、可视 4 行，超出滚动；
 *     卡片悬停给出全部操作：模型可用开关、用户可用开关、重命名、复制到别的根、
 *     查看 SKILL.md、删除；点卡片展开详情。
 *   - 导入本地：内置目录浏览（Host 的 `/skill-manager/browse`）+ 直接粘路径，
 *     支持目录与单个 `.md` 技能文件，可选覆盖。
 *   - 技能市场：搜索 → 选目标技能根 → 安装；已装列表可卸载。
 *   - 回收站：还原 / 彻底删除 / 清空。
 *
 * `/` 菜单源提供**两级提示**：`/skill/` 列技能目录 → `/skill/<目录>/` 列该目录下的技能，
 * 选中后插入 `/skill/<目录>/<技能>`（Host 侧 pre-step 手势负责注入技能内容）。
 *
 * 通信只用 Host 用 `webServer` 注册的同源路由（第三方插件拿不到 typert Remote）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-skill-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 字典命名空间。 */
    const NS = 'skillManager'
    /** 侧栏页面 id（同时也是 main 面板的 key）。 */
    const PANEL_ID = 'skills'
    /** 每行卡片数 / 可视行数（需求：每行 6 个、展示 4 行）。 */
    const COLUMNS = 6
    const VISIBLE_ROWS = 4
    /** 卡片行高：原来是 132px，用户要求 200% → 264px。 */
    const CARD_HEIGHT = 264
    /** 工作目录的记忆键。 */
    const CWD_KEY = 'dsh.skill-manager.cwd'
    /** 导入目标技能根的记忆键（导入弹窗不再放目标选择，改在设置里定）。 */
    const IMPORT_ROOT_KEY = 'dsh.skill-manager.importRoot'
    /** 宽版弹窗的类名（详情用；样式由下面注入的那一小段 CSS 提供）。 */
    const WIDE_DIALOG_CLASS = 'dsh-skill-manager-dialog-wide'
    /** 导入弹窗的类名（DSH 默认弹窗宽 min(380px,100%)，这里 +50%）。 */
    const IMPORT_DIALOG_CLASS = 'dsh-skill-manager-dialog-import'
    /** 开关（照抄 DSH `Switch.module.css`）、危险按钮、状态点、详情 facts 列表的类名。 */
    const SWITCH_CLASS = 'dsh-sm-switch'
    const SWITCH_THUMB_CLASS = 'dsh-sm-switch-thumb'
    const DANGER_CLASS = 'dsh-sm-danger'
    const DANGER_SOLID_CLASS = 'dsh-sm-danger-solid'
    const COMPACT_CLASS = 'dsh-sm-compact'
    const FACTS_CLASS = 'dsh-sm-facts'
    const SELECT_CLASS = 'dsh-sm-select'
    const CARD_CLASS = 'dsh-sm-card'
    const FIELD_CLASS = 'dsh-sm-field'
    const MENU_ITEM_CLASS = 'dsh-sm-menu-item'
    /**
     * 注入的样式补丁。**每一段都照抄 DSH 自己的组件样式表**（`app.asar` 里的
     * `PluginManagerPage.module.css` / `Switch.module.css`），这样插件里的卡片、开关、
     * 危险按钮跟宿主"插件"页长得一样；`--dsw-*` 变量缺失时才退回写死的兜底色。
     */
    const DIALOG_CSS = [
        // 详情：3 倍（1140px）后再收窄 20% → 1056px；上限按住视口。
      `.${WIDE_DIALOG_CLASS}{width:min(1056px,75vw)!important;max-width:min(1056px,75vw)!important;}`,
        // 导入：380 × 1.5 = 570px。
      `.${IMPORT_DIALOG_CLASS}{width:min(570px,92vw)!important;max-width:min(570px,92vw)!important;}`,
        // 开关：36×20 轨道 + 16px 滑块；开=brand-primary，关=border-l3；滑块右移 16px。
      `.${SWITCH_CLASS}{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.45));cursor:pointer;transition:background .12s ease;}`,
      `.${SWITCH_CLASS}[aria-checked="true"]{background:#00CC00;}`,
      `.${SWITCH_CLASS}:disabled{cursor:default;opacity:.5;}`,
      `.${SWITCH_CLASS}:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;}`,
      `.${SWITCH_THUMB_CLASS}{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .12s ease;}`,
      `.${SWITCH_CLASS}[aria-checked="false"] .${SWITCH_THUMB_CLASS}{background:var(--dsw-alias-switch-thumb,#fff);}`,
      `.${SWITCH_CLASS}[aria-checked="true"] .${SWITCH_THUMB_CLASS}{transform:translate(16px);}`,
        // 危险按钮（DSH「插件详情 → 卸载」那一个）：白底 + 红字 + 淡红描边，hover 淡红底。
      `.${DANGER_CLASS}{color:var(--dsw-alias-state-error-primary,#d4380d)!important;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent)!important;background:transparent!important;}`,
      `.${DANGER_CLASS}:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05))!important;}`,
        // 确认删除弹窗里那一下：DSH 的做法是把主按钮的填充色换成报错色。
      `.${DANGER_SOLID_CLASS}{--dsw-alias-button-primary-fill:var(--dsw-alias-state-error-primary,#d4380d);--dsw-alias-button-primary-hover:var(--dsw-alias-state-error-primary,#d4380d);}`,
        // 卡片里的小号按钮（DSH `rowActions` 的尺寸：28px 高、12px 字）。
        // 内距 8px：6 列网格下卡片约 180px，删除+详情+开关必须挤得进一行。
      `.${COMPACT_CLASS}{height:28px!important;padding:0 8px!important;font-size:12px!important;line-height:18px!important;border-radius:6px!important;}`,
        // 禁用态要看得出来（「确定」在没有改动时就是禁用）：DSH 的按钮也是整体变淡。
      `.${COMPACT_CLASS}:disabled{opacity:.45;cursor:default;}`,
        // 状态点：8px 圆点，成功=绿、遮蔽=橙、无效=红、其它=三级文字色。
        // 详情页的 facts 列表：左右两端对齐、行间 0.5px 分隔线。        // DSH 原版是 `min-height:44px;padding:8px 2px`（一行约 60px），这里按用户要求压到一半。
      `.${FACTS_CLASS}{margin:0;}`,
      // 用**直接子元素**选择器：详情行里的下拉浮层面板也是 div，不能把它也套上行的横线。
      `.${FACTS_CLASS} > div{display:flex;justify-content:space-between;align-items:center;gap:16px;min-height:22px;padding:4px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));}`,
      `.${FACTS_CLASS} > div:last-child{border-bottom:0;}`,
      `.${FACTS_CLASS} dt{flex:none;margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,inherit);}`,
      `.${FACTS_CLASS} dd{margin:0;min-width:0;text-align:end;overflow-wrap:anywhere;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);}`,
        // 筛选字段框：hover 时边框加深 + 浅底（整块就是一个控件，hover 感应在框上，
        // 而不是框里那个小按钮上——否则会在框里出现第二层高亮）。
      `.${FIELD_CLASS}:hover{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.45))!important;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06))!important;}`,
      `.${SELECT_CLASS}:disabled{color:var(--dsw-alias-label-dimmed,inherit);cursor:default;}`,
      `.${SELECT_CLASS}:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));border-radius:var(--dsw-radius-sm,4px);}`,
        // 展开时箭头转 180°（DSH 的 `chevronOpen`）。
      `.${SELECT_CLASS}[aria-expanded="true"] .dsh-sm-chevron{transform:rotate(180deg);}`,
        // 浮层里的每一行：**只有悬停/键盘高亮**上底色；选中项只靠右侧对勾，不加底色。
      `.${MENU_ITEM_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))!important;}`,
        // 详情页多选（分类）的行也要有 hover 底色，跟单选菜单一致。
      `.dsh-sm-pop-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))!important;}`,
      `.${MENU_ITEM_CLASS}:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px;}`,
        // 卡片悬浮：DSH 插件卡片的 `:hover{background:var(--dsw-alias-interactive-bg-hover)}`。
      `.${CARD_CLASS}{transition:background .12s ease,border-color .12s ease;}`,
      `.${CARD_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))!important;border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.3))!important;}`,
    ].join('')
    /**
     * 浏览器半边的构建标记。宿主半边 `index.js` 里有同名的 `HOST_BUILD`：
     * 两边不一致就说明**宿主半边没被重启**（改了 `index.js` 必须完整重启，HMR 只换客户端），
     * 这时界面会直接提示，而不是让用户去猜"为什么导入报了个奇怪的错"。
     */
    const CLIENT_BUILD = 'build-2026-10-16-17'

    const ROUTE = {
      catalog: '/skill-manager/catalog',
      action: '/skill-manager/action',
      read: '/skill-manager/read',
      browse: '/skill-manager/browse',
      importUpload: '/skill-manager/import-upload',
      market: '/skill-manager/market',
      install: '/skill-manager/market/install',
      uninstall: '/skill-manager/market/uninstall',
    }

    /**
     * DSH 自带的共享 UI 原子（按钮/输入/弹窗/图标/徽章）。
     *
     * 第三方客户端 bundle 通过模块表 `require` 它——内置的 12 个客户端包都是这么用的。
     * 拿不到就退回自带的 HTML + `--dsw-*` 变量版本，绝不让整页因为一个可选依赖变白。
     */
    let UI
    try {
      UI = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      UI = undefined
    }

    /** DSH 图标描边宽度（Regular）。 */
    const ICON_STROKE = 1

    /**
     * DSH 的刷新图标（路径数据与 `@deepseek-ai/dsh-client-ui-primitives` 的
     * `IconRefreshOutlineArtwork` 一致；取不到组件库时用它，保证和 DSH 同一个字形）。
     * @param {{size?: number}} props 属性。
     * @returns {any} 元素。
     */
    function RefreshIcon(props) {
      const size = (props && props.size) || 16
      if (UI && UI.IconRefreshOutlineRegular) return h(UI.IconRefreshOutlineRegular, { size })
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        strokeWidth: ICON_STROKE,
      },
        h('path', { d: 'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1', stroke: 'currentColor' }),
        h('path', { d: 'M14.4999 1.5V5.1H10.8999', stroke: 'currentColor' }))
    }

    /**
     * 关闭图标（同上：与 DSH 的 `IconCloseOutlineArtwork` 同路径）。
     * @param {{size?: number}} props 属性。
     * @returns {any} 元素。
     */
    function CloseIcon(props) {
      const size = (props && props.size) || 16
      if (UI && UI.IconCloseOutlineRegular) return h(UI.IconCloseOutlineRegular, { size })
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        strokeWidth: ICON_STROKE,
      },
        h('path', { d: 'M2.5 2.5L13.5 13.5', stroke: 'currentColor' }),
        h('path', { d: 'M13.5 2.5L2.5 13.5', stroke: 'currentColor' }))
    }

    /**
     * 关闭按钮（只有图标那一颗）：自己的 title 走 DSH 气泡，不留原生 tooltip。
     * @param {{onClick?: Function, label?: string}} props 属性。
     * @returns {any} 元素。
     */
    function CloseButton(props) {
      const label = props.label || t('close')
      return h(HoverBubble, { tag: 'span', text: label, tipKey: 'icon', style: styles.tipAnchor },
        h('button', {
          type: 'button',
          style: styles.iconButton,
          'aria-label': label,
          onClick: props.onClick,
        }, h(CloseIcon, { size: 14 })))
    }

    /**
     * 按钮：有 DSH 组件库就用它（风格、hover、focus 环完全一致），否则退到自带样式。
     *
     * `title` **不再交给浏览器**（原生 tooltip 是系统灰底样式，跟 DSH 不一致），
     * 改成用 `HoverBubble` 画同样的 DSH 气泡。
     * @param {object} props 属性。
     * @returns {any} 元素。
     */
    function Btn(props) {
      const { variant, icon, style, className, children, title, ...rest } = props
      let button
      if (UI && UI.Button) {
        button = h(UI.Button, { variant, icon, className, ...rest }, children)
      } else {
        const variantStyle = variant === 'primary' ? styles.buttonPrimary : undefined
        // `className` 必须带给回退版按钮：`dsh-sm-compact` / `dsh-sm-danger` 这些补丁样式
        // 全靠它挂上去（漏过一次，回退样式下按钮既不是红色也不是 28px 高）。
        button = h('button', { type: 'button', className, style: { ...styles.button, ...variantStyle, ...style }, ...rest },
          icon ? h('span', { style: { display: 'inline-flex', marginRight: '4px', verticalAlign: '-3px' } }, icon) : null,
          children)
      }
      if (!title) return button
      return h(HoverBubble, { tag: 'span', text: title, tipKey: 'button', style: styles.tipAnchor }, button)
    }

    const zh = {
      panel: '技能',
      title: '技能管理器',
      tabInstalled: '已安装',
      tabMarket: '技能市场',
      tabTrash: '回收站',
      settings: '设置',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '读取中…',
      cwd: '工作目录',
      cwdHint: '决定项目级技能根算在哪个项目下；留空用 Host 的当前目录。',
      rootFilter: '技能目录',
      allRoots: '全部目录',
      categoryFilter: '分类',
      allCategories: '全部分类',
      uncategorized: '未分类',
      importLocal: '导入本地',
      importTitle: '导入本地技能',
      importDesc: '把技能文件夹（含 SKILL.md）拖进来，或点击浏览本地目录。',
      dropHint: '拖拽技能文件夹到这里',
      dropClickHint: '或点击浏览本地目录',
      dropEmpty: '没有识别到文件',
      importing: '导入中…',
      conflictTitle: '已存在同名技能',
      conflictAsk: '已经存在，要覆盖它吗？',
      overwrite: '覆盖',
      cancel: '取消',
      ok: '确定',
      editHint: '修改后点「确定」才生效（会同时更新注册表）',
      categories: '分类',
      pickCategory: '选择分类',
      newCategory: '新分类名',
      addOne: '添加',
      categoryLimit: '最多 5 个分类',
      categoryDup: '已经有这个分类了',
      categoryComma: '分类名不能包含逗号',
      renameCategory: '改名',
      rootReadonly: '只读，不能放技能',
      saveDone: '已保存',
      slashWarn: '斜杠提示异常（请把这一行发给开发者）：',
      importGo: '导入',
      importTarget: '导入到',
      chooseImportRoot: '导入目标',
      importRootHint: '「导入本地」把技能装到这里',
      importDone: '已导入',
      browsing: '读取中…',
      nothingHere: '这个目录里没有子目录',
      buildMismatch: '客户端与宿主半边版本不一致',
      clientBuild: '客户端',
      hostBuild: '宿主',
      buildMismatchHint: '宿主半边不会热更新——请完全退出 DSH Desktop 再打开',
      settingsTitle: '设置',
      settingsReadonly: '市场地址与技能根是只读的：改这两项请编辑 profile 的 cordis.patch.yml 后重启 Host。下面的工作目录与导入目标可以直接改，会记住。',
      marketUrl: '市场地址',
      unconfigured: '未配置',
      homes: '目录',
      rootsTitle: '技能目录',
      registry: '注册表',
      registryAt: '最近重建',
      skillCount: '共',
      unit: '个技能',
      statusEffective: '生效',
      statusPredicted: '按优先级推算',
      statusShadowed: '被遮蔽',
      statusInvalid: '无效',      statusProvider: '插件提供',
      readonlyRoot: '只读',
      missingRoot: '目录不存在',
      cancel: '取消',
      viewFile: '查看 SKILL.md',
      hideFile: '收起文件',
      detail: '详情',
      status: '状态',
      statusOffHint: '已停用：把开关打开就能重新被调用',
      switchOn: '启用',
      switchOff: '停用',
      switchLockedInvalid: 'SKILL.md 校验没通过（DSH 不会加载它），开关无效',
      switchLockedShadowed: '同名技能被更高优先级的技能根占了，开关改不了谁生效',
      switchOnDone: '已启用',
      switchOffDone: '已停用',
      confirmDeleteTitle: '确认删除技能',
      purgeTitle: '彻底删除这个技能',
      purgeAllTitle: '清空回收站',
      purgeAllAsk: '回收站里的技能会被永久删除，无法恢复。继续？',
      trash: '删除',
      confirmTrash: '删除后进回收站，可随时还原。继续？',
      confirmPurge: '彻底删除后无法恢复。继续？',
      empty: '还没有技能。把技能文件夹放进任一技能目录，或点「导入本地」。',
      emptyFiltered: '这个目录下没有技能。',
      details: '描述',
      provider: '来源',
      path: '路径',
      resources: '资源',
      issues: '问题',
      marketSearch: '搜索技能',
      searchGo: '搜索',
      installing: '安装中…',
      install: '安装',
      installedAt: '安装位置',
      installedVersion: '已装',
      uninstall: '卸载',
      marketHint: '安装前会展示文件清单与摘要；只写入你选定的技能根。',
      confirmInstallTitle: '确认安装',
      bundleDigest: '包摘要',
      marketUnconfigured: '未配置市场地址（marketUrl）：这一版市场是关的。',
      trashEmpty: '回收站是空的。',
      restore: '还原',
      purge: '彻底删除',
      purgeAll: '清空回收站',
      actionFailed: '操作失败',
      done: '完成',
      warnings: '警告',
      confirmInstall: '确认安装',
      close: '关闭',
    }

    const en = {
      panel: 'Skills',
      title: 'Skill manager',
      tabInstalled: 'Installed',
      tabMarket: 'Skill market',
      tabTrash: 'Trash',
      settings: 'Settings',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Loading…',
      cwd: 'Working directory',
      cwdHint: 'Decides which project skill roots are scanned; empty uses the Host cwd.',
      rootFilter: 'Skill directory',
      allRoots: 'All directories',
      categoryFilter: 'Category',
      allCategories: 'All categories',
      uncategorized: 'Uncategorized',
      importLocal: 'Import local',
      importTitle: 'Import a local skill',
      importDesc: 'Drag a skill folder (with SKILL.md) in, or click to browse local folders.',
      dropHint: 'Drop a skill folder here',
      dropClickHint: 'or click to browse local folders',
      dropEmpty: 'No files detected',
      importing: 'Importing…',
      conflictTitle: 'A skill with this name already exists',
      conflictAsk: 'already exists — overwrite it?',
      overwrite: 'Overwrite',
      cancel: 'Cancel',
      ok: 'OK',
      editHint: 'Changes apply when you press OK (the registry is updated too)',
      categories: 'Categories',
      pickCategory: 'Pick categories',
      newCategory: 'New category',
      addOne: 'Add',
      categoryLimit: 'Up to 5 categories',
      categoryDup: 'That category already exists',
      categoryComma: 'Category names cannot contain commas',
      renameCategory: 'Rename',
      rootReadonly: 'Read-only, cannot hold skills',
      saveDone: 'Saved',
      slashWarn: 'Slash hint problem (send this line to the developer):',
      importGo: 'Import',
      importTarget: 'Import into',
      chooseImportRoot: 'Import target',
      importRootHint: 'Import local installs here',
      importDone: 'Imported',
      browsing: 'Loading…',
      nothingHere: 'No subdirectories here',
      buildMismatch: 'Client and host halves are out of sync',
      clientBuild: 'client',
      hostBuild: 'host',
      buildMismatchHint: 'the host half is not hot-reloaded — fully quit and reopen DSH Desktop',
      settingsTitle: 'Settings',
      settingsReadonly: 'marketUrl and skill roots are read-only: edit them in the profile cordis.patch.yml and restart the Host. The working directory and import target below can be changed here and are remembered.',
      marketUrl: 'Market URL',
      unconfigured: 'not configured',
      homes: 'Directories',
      rootsTitle: 'Skill directories',
      registry: 'Registry',
      registryAt: 'Last rebuilt',
      skillCount: 'Total',
      unit: 'skills',
      statusEffective: 'effective',
      statusPredicted: 'by rank',
      statusShadowed: 'shadowed',
      statusInvalid: 'invalid',
      statusProvider: 'plugin-provided',
      readonlyRoot: 'read-only',
      missingRoot: 'directory missing',
      cancel: 'Cancel',
      viewFile: 'View SKILL.md',
      hideFile: 'Hide file',
      detail: 'Details',
      status: 'Status',
      statusOffHint: 'Off: flip the switch to let it be invoked again',
      switchOn: 'Enable',
      switchOff: 'Disable',
      switchLockedInvalid: 'SKILL.md failed validation (DSH will not load it), so the switch does nothing',
      switchLockedShadowed: 'A same-named skill in a higher-rank root wins, so this switch cannot decide what takes effect',
      switchOnDone: 'Enabled',
      switchOffDone: 'Disabled',
      confirmDeleteTitle: 'Delete this skill?',
      purgeTitle: 'Delete this skill forever',
      purgeAllTitle: 'Empty the trash',
      purgeAllAsk: 'Every skill in the trash will be deleted for good. Continue?',
      trash: 'Delete',
      confirmTrash: 'It goes to the trash and can be restored. Continue?',
      confirmPurge: 'This cannot be undone. Continue?',
      empty: 'No skills yet. Drop a skill folder into a skill directory, or use Import local.',
      emptyFiltered: 'No skills under this directory.',
      details: 'Description',
      provider: 'Provider',
      path: 'Path',
      resources: 'Resources',
      issues: 'Issues',
      marketSearch: 'Search skills',
      searchGo: 'Search',
      installing: 'Installing…',
      install: 'Install',
      installedAt: 'Installed at',
      installedVersion: 'installed',
      uninstall: 'Uninstall',
      marketHint: 'The file list and digests are shown before install; only the chosen root is written.',
      confirmInstallTitle: 'Confirm install',
      bundleDigest: 'bundle digest',
      marketUnconfigured: 'No market URL configured (marketUrl): the market is off in this build.',
      trashEmpty: 'The trash is empty.',
      restore: 'Restore',
      purge: 'Delete forever',
      purgeAll: 'Empty trash',
      actionFailed: 'Action failed',
      done: 'Done',
      warnings: 'Warnings',
      confirmInstall: 'Confirm install',
      close: 'Close',
    }

    const BORDER = '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))'
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

    const styles = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '14px 18px 18px', gap: '12px', overflow: 'hidden' },
      topbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', flex: 'none' },
      tabRow: { display: 'flex', alignItems: 'center', gap: '4px' },
      tab: { padding: '4px 12px', borderRadius: '999px', border: '1px solid transparent', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '13px' },
      tabActive: { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.18))', fontWeight: 600 },
      main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px', overflow: 'hidden' },
      toolbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', flex: 'none' },
      title: { fontSize: '15px', fontWeight: 600, marginRight: '6px' },
      spacer: { flex: 1 },
      input: { padding: '5px 8px', borderRadius: '6px', border: BORDER, background: 'transparent', color: 'inherit', fontSize: '13px', minWidth: '120px' },
      // 每个筛选器是一个**带边框的字段**（DSH 搜索框那种 `.wrap`：`.5px` 边、32px 高、圆角 md），
      // 两个筛选器靠各自的边框分界。里面那个按钮本身无边框，只负责文字 + 箭头。
      filterField: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '32px',
        padding: '0 8px',
        border: '0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.35))',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      },
      filterLabel: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, inherit)', flex: 'none' },
      filterTrigger: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '28px',
        maxWidth: '200px',
        padding: '0 2px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '13px',
        fontWeight: 500,
        lineHeight: '20px',
        cursor: 'pointer',
        outline: 'none',
      },
      filterValue: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
      // 浮层：照 DSH `.Z9Jnlq_menu`（4px 内距、圆角、prominent 阴影）+ `.Z9Jnlq_item`（34px 行高）。
      filterMenu: {
        position: 'absolute',
        top: 'calc(100% + 4px)',
        left: 0,
        minWidth: '100%',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        padding: '4px',
        maxHeight: '320px',
        overflowY: 'auto',
        // 浮层：照 DSH `.Z9Jnlq_menu`（4px 内距、圆角、prominent 阴影）+ `.Z9Jnlq_item`（34px 行高）。
        // 背景**必须是不透明底色**：菜单浮在卡片上，半透明会把下面的文字透出来。
        background: 'var(--dsw-alias-bg-base, #ffffff)',
        border: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))',
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 10px 30px rgba(0,0,0,0.18))',
      },
      filterItem: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minHeight: '34px',
        padding: '6px 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '13px',
        lineHeight: '20px',
        textAlign: 'left',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      filterItemText: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' },
      grow: { flex: 1, minWidth: '140px' },
      button: { padding: '5px 10px', borderRadius: '6px', border: BORDER, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px' },
      // 主按钮：照抄 DSH 自己的主按钮配方（`button-primary-fill` 实心 + 反白字），
      // 描边按钮就是下面那个 `button`。没有组件库时也跟宿主保持同一层级。
      buttonPrimary: {
        borderColor: 'transparent',
        background: 'var(--dsw-alias-button-primary-fill, #1f1f1f)',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        fontWeight: 500,
      },
      iconButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '24px', height: '24px', padding: 0, borderRadius: '6px', border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      buttonDanger: { color: '#d4380d' },
      // 详情页编辑用的下拉浮层：与外层筛选器同一套观感（不透明底 + prominent 阴影 + 圆角）。
      // **position:fixed**：弹窗正文可能滚动/裁剪，fixed 才不会被裁掉。
      popMenu: {
        position: 'fixed',
        zIndex: 1250,
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base, #ffffff)',
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.16))',
        border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))',
        padding: '6px',
        overflowY: 'auto',
        overflowX: 'hidden',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      popRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        // box-sizing 很重要：width:100% 再叠加 padding 会撑出横向滚动条。
        boxSizing: 'border-box',
        width: '100%',
        minHeight: '32px',
        padding: '4px 6px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      popRowOff: { opacity: 0.45, cursor: 'default' },
      // 注意：这里**只用长写**（borderWidth/Style/Color）。混用 `border` 简写与 `borderColor`
      // 时，React 在"勾选 → 反勾选"的重渲染里会同时丢掉这两个属性，方框直接消失（真出过的 bug）。
      popCheck: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        width: '16px',
        height: '16px',
        flex: 'none',
        borderRadius: '4px',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'var(--dsw-alias-border-l3, rgba(127,127,127,0.4))',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        background: 'transparent',
      },
      popCheckOn: {
        background: 'var(--dsw-alias-button-primary-fill, #1f1f1f)',
        borderColor: 'var(--dsw-alias-button-primary-fill, #1f1f1f)',
      },
      popRowText: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      popHint: { padding: '4px 6px', fontSize: '11.5px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, inherit)' },
      // 行内的小注解（例如「只读，不能放技能」）：不吃宽度，靠右且不换行。
      popRowNote: { flex: 'none', marginLeft: 'auto', fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, inherit)', whiteSpace: 'nowrap' },
      popInput: {
        flex: '1 1 auto',
        minWidth: 0,
        height: '26px',
        padding: '0 6px',
        border: '0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.4))',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12.5px',
        fontFamily: 'inherit',
      },
      // 单选下拉（替代原生 <select>）：框 + 值 + 箭头，观感跟外层筛选器一致。
      editValue: { display: 'inline-flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0 },
      body: { flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: '2px' },
      grid: {
        display: 'grid',
        gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))`,
        gap: '10px',
        gridAutoRows: `${CARD_HEIGHT}px`,
        // 可视 4 行，更多则滚动。
        maxHeight: `calc(${VISIBLE_ROWS} * ${CARD_HEIGHT}px + ${VISIBLE_ROWS - 1} * 10px)`,
        overflowY: 'auto',
      },
      // 卡片：内距与圆角照 DSH 的插件卡片（`.fO69Vq_card` 圆角 + `cardHead` 内距）。
      card: { position: 'relative', border: BORDER, borderRadius: 'var(--dsw-radius-lg, 12px)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden', cursor: 'pointer' },
      cardOpen: { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))' },
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
      cardName: { fontFamily: MONO, fontSize: '12.5px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // 卡片标题/描述：字号字重行高照 DSH `cardTitle`(14/500/20) 与 `cardDesc`(13/18, 三级文字色)。
      // 描述在分割线以下、吃掉卡片剩下的高度，最多 7 行（7 × 18 = 126px）：
      // **显式 max-height 而不是只靠 `-webkit-line-clamp`**——这个元素当 flex 子项被拉伸时，
      // Chrome 不按 clamp 截断，会露出半行字。
      cardTitle: { fontSize: '14px', fontWeight: 500, lineHeight: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '1 1 auto' },
      cardDesc: {
        fontSize: '13px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        maxHeight: '126px',
        display: '-webkit-box',
        WebkitLineClamp: 7,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        flex: '1 1 auto',
        minHeight: 0,
      },
      cardTags: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      // 删除 / 详情：压到卡片最下方，右对齐。
      cardActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', flexWrap: 'wrap', marginTop: 'auto' },
      // 标签行之后的分割线；线以下全是介绍。
      cardDivider: { height: 0, borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))' },
      // 悬浮提示：照 DSH 的 Tooltip 气泡（`_bubble_12mhf_1`）——tooltip-bg 底、13/20、
      // 小圆角、`position:fixed`（卡片有 overflow:hidden，fixed 才不会被裁掉）。
      // 气泡锚点：包住触发元素的 span，只用来挂 hover 事件，不改变原有排版。
      tipAnchor: { display: 'inline-flex', alignItems: 'center', minWidth: 0 },
      tipBubble: {
        position: 'fixed',
        zIndex: 1300,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        width: 'max-content',
        maxWidth: '50vw',
        padding: '3px 7px',
        borderRadius: 'var(--dsw-radius-sm, 4px)',
        background: 'var(--dsw-alias-tooltip-bg, #2b2f36)',
        color: 'var(--dsw-static-neutral-bluish-00, #ffffff)',
        fontSize: '13px',
        lineHeight: '20px',
        whiteSpace: 'pre-line',
        overflowWrap: 'break-word',
        pointerEvents: 'none',
        boxShadow: 'var(--dsw-elevation-prominent, 0 6px 18px rgba(0,0,0,0.2))',
      },
      // 标签（技能目录 / 分类）：11px、圆角、半透明同色底（颜色由文字散列决定）。
      chip: {
        display: 'inline-block',
        maxWidth: '100%',
        padding: '0 6px',
        borderRadius: '4px',
        fontSize: '11px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      badge: { fontSize: '10.5px', padding: '1px 6px', borderRadius: '999px', border: '1px solid currentColor', opacity: 0.9, whiteSpace: 'nowrap' },
      muted: { fontSize: '11px', opacity: 0.7 },
      error: { color: '#d4380d', fontSize: '12px' },
      warn: { color: '#d46b08', fontSize: '12px' },
      detail: { border: BORDER, borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '10px' },
      kv: { display: 'grid', gridTemplateColumns: '104px 1fr', gap: '4px 10px', fontSize: '12px' },
      pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: MONO, fontSize: '11px', opacity: 0.9, maxHeight: '320px', overflowY: 'auto', background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))', padding: '8px 10px', borderRadius: '8px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      listItem: { border: BORDER, borderRadius: '10px', padding: '9px 12px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      // 回收站的行：DSH 插件列表那种「顶部细线分隔的 ul/li」，不是一叠卡片。
      // 只有两行字（名字 + 来源/时间），所以行内距比三行版本小一点。
      trashList: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none' },
      trashRow: { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', padding: '8px 2px', borderBottom: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))' },
      trashMain: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 240px' },
      trashName: { fontSize: '13.5px', fontWeight: 500, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, inherit)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      trashMeta: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, inherit)' },
      // 来源根标签：DSH 那种小圆角灰底（不是描边胶囊）。
      trashBadge: { fontSize: '11px', lineHeight: '18px', padding: '0 6px', borderRadius: '4px', background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.12))', color: 'var(--dsw-alias-label-secondary, inherit)' },
      trashActions: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', flex: 'none' },
      overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 },
      dialog: { width: 'min(570px, 92vw)', maxHeight: '84vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', borderRadius: '12px', background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit', border: BORDER, boxShadow: '0 12px 40px rgba(0,0,0,0.28)' },
      // 确认框用 DSH 的默认弹窗宽度（min(380px,100%) 那种窄宽度），不跟导入/设置一样宽。
      dialogConfirm: { width: 'min(400px, 92vw)', maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', borderRadius: '12px', background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit', border: BORDER, boxShadow: '0 12px 40px rgba(0,0,0,0.28)' },
      // 详情弹窗：信息多，宽度≈默认的 3 倍再收窄 20%（上限不超视口）。
      dialogWide: { width: 'min(1056px, 75vw)', maxHeight: '88vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', borderRadius: '12px', background: 'var(--dsw-alias-bg-base, #fff)', color: 'inherit', border: BORDER, boxShadow: '0 12px 40px rgba(0,0,0,0.28)', overflowY: 'auto' },
      browseList: { flex: 1, minHeight: '160px', maxHeight: '38vh', overflowY: 'auto', border: BORDER, borderRadius: '8px' },
      browseRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 9px', cursor: 'pointer', fontSize: '12.5px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14))' },
      browseName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      dropzone: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        padding: '26px 16px',
        border: `1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,0.45))`,
        borderRadius: '10px',
        cursor: 'pointer',
        textAlign: 'center',
      },
      dropzoneActive: {
        borderStyle: 'solid',
        borderColor: 'var(--dsw-alias-interactive-border, rgba(127,127,127,0.8))',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))',
      },
      dropTitle: { fontSize: '13px' },
      pickedPath: {
        fontFamily: MONO,
        fontSize: '11.5px',
        opacity: 0.85,
        wordBreak: 'break-all',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
        borderRadius: '6px',
        padding: '6px 8px',
      },
    }

    /** 当前语言取词；未注册字典时回退自带中文。 */
    let t = (key) => key

    /**
     * 同源调用 Host 路由。
     * @param {string} route 路由。
     * @param {object} [options] fetch 选项。
     * @returns {Promise<object>} JSON 结果。
     */
    async function call(route, options) {
      const response = await fetch(route, {
        credentials: 'same-origin',
        headers: options && options.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        ...options,
        ...options && options.body !== undefined ? { body: JSON.stringify(options.body) } : {},
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`${route} 返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
      return payload
    }

    /**
     * 小徽章：有 DSH 的 `Tag` 就用它（配色随主题），否则退回自带描边胶囊。
     * @param {{children: any, tone?: string, title?: string}} props 属性。
     * @returns {any} 元素。
     */
    function Badge(props) {
      const palette = props.tone === 'danger' ? 'red' : props.tone === 'warn' ? 'orange' : props.tone === 'ok' ? 'green' : 'grey'
      if (UI && UI.Tag) return h(UI.Tag, { tone: palette }, props.children)
      const tone = props.tone === 'danger'
        ? '#d4380d'
        : props.tone === 'warn' ? '#d46b08' : props.tone === 'ok' ? '#389e0d' : 'currentColor'
      const pill = {
        style: { ...styles.badge, color: tone, opacity: tone === 'currentColor' ? 0.7 : 1 },
      }
      // 徽章的说明文字也走 DSH 气泡（不留原生 title）。
      if (!props.title) return h('span', pill, props.children)
      return h(HoverBubble, { tag: 'span', text: props.title, tipKey: 'badge', style: styles.tipAnchor },
        h('span', pill, props.children))
    }

    /** 徽章的另一个名字（弹窗里用 `Tag` 更贴近 DSH 的叫法）。 */
    const Tag = Badge

    /**
     * 「未分类」在分类筛选里的值（真实分类名不会长成这样）。
     */
    const UNCATEGORIZED = '\u0000uncategorized'

    /**
     * 取一个技能的 `metadata.category`，统一成字符串数组。
     *
     * 三种写法都要认：行内数组、列表块（解析后就是数组）、以及**逗号分隔的标量**
     * （管理器自己写出去的就是 `category: a, b` 这种）。
     * @param {object} skill 技能。
     * @returns {string[]} 分类列表（去重、去空白）。
     */
    function skillCategories(skill) {
      const metadata = skill && skill.metadata
      if (!metadata || typeof metadata !== 'object') return []
      const raw = metadata.category
      if (raw === undefined || raw === null || raw === '') return []
      const list = Array.isArray(raw)
        ? raw
        : typeof raw === 'object' ? [] : String(raw).split(',')
      const out = []
      for (const item of list) {
        const value = String(item ?? '').trim()
        if (value === '' || out.includes(value)) continue
        out.push(value)
      }
      return out
    }

    /** 分类上限（与宿主同一条规则）。 */
    const MAX_CATEGORIES = 5

    /**
     * 两个分类列表是否等价（顺序无关）。
     * @param {string[]} left 左。
     * @param {string[]} right 右。
     * @returns {boolean} 等价返回 true。
     */
    function sameCategories(left, right) {
      if (left.length !== right.length) return false
      const set = new Set(left)
      return right.every((item) => set.has(item))
    }

    /**
     * DSH 风格的下拉筛选器。
     *
     * 原生 `<select>` 的弹出面板没法改样式（浏览器自己画），所以这里做成
     * **按钮 + 浮层列表**，参数照 DSH 的 `.Z9Jnlq_menu` / `.Z9Jnlq_item`：
     * 面板 4px 内距、圆角、`--dsw-elevation-prominent` 阴影，每项 34px 高、圆角、
     * hover 用 `interactive-bg-hover`，当前项在右侧打勾。
     * @param {{label: string, value: string, options: Array<{value: string, label: string}>,
     *   onChange: Function, disabled?: boolean, name?: string}} props 属性。
     * @returns {any} 元素。
     */
    function FilterSelect(props) {
      const [open, setOpen] = React.useState(false)
      const [menuPos, setMenuPos] = React.useState(undefined)
      const wrapRef = React.useRef(null)
      // 浮层用 fixed 定位：同一个组件既能用在工具栏，也能用在弹窗里（弹窗正文可能裁剪 absolute 面板）。
      React.useLayoutEffect(() => {
        if (!open) {
          setMenuPos(undefined)
          return
        }
        const node = wrapRef.current
        if (!node || typeof node.getBoundingClientRect !== 'function') return
        const box = node.getBoundingClientRect()
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 0
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 0
        const width = Math.max(box.width || 0, 180)
        const below = box.bottom + 4
        const top = vh - below >= 160 ? below : Math.max(8, box.top - 204)
        setMenuPos({
          left: Math.max(8, Math.min(box.left, Math.max(8, vw - width - 8))),
          top,
          width,
          maxHeight: Math.max(120, Math.min(320, vh - top - 12)),
        })
      }, [open])
      React.useEffect(() => {
        if (!open) return undefined
        // 点外面 / 按 Esc 收起（浮层不是弹窗，不抢焦点）。
        const onDown = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])
      const current = props.options.find((item) => item.value === props.value) || props.options[0]
      const valueRef = React.useRef(null)
      const hasLabel = typeof props.label === 'string' && props.label !== ''
      const pick = (value) => {
        setOpen(false)
        if (value !== props.value) props.onChange(value)
      }
      // 触发器上**不挂原生 `title`**（系统灰底样式跟 DSH 不一致，而且左边已经有可见的标签）。
      // 只有当前选项文字被省略时，才用 DSH 气泡显示完整值。
      const trigger = h('button', {
        type: 'button',
        className: SELECT_CLASS,
        style: styles.filterTrigger,
        'aria-haspopup': 'listbox',
        'aria-expanded': open ? 'true' : 'false',
        'data-sm-select': props.name,
        disabled: props.disabled === true,
        onClick: () => setOpen(!open),
      },
        // 值可以直接是文字，也可以是自定义节点（详情页要把"技能目录"渲染成彩色标签）。
        props.renderValue !== undefined
          ? h('span', { ref: valueRef, style: styles.filterValue, 'data-sm-filter-value': props.name }, props.renderValue)
          : h('span', { ref: valueRef, style: styles.filterValue, 'data-sm-filter-value': props.name }, current ? current.label : ''),
        h(ChevronIcon, { size: 14, className: 'dsh-sm-chevron' }))
      return h('div', { ref: wrapRef, className: FIELD_CLASS, style: styles.filterField, 'data-sm-filter': props.name },
        hasLabel ? h('span', { style: styles.filterLabel }, props.label) : null,
        h(HoverBubble, {
          tag: 'span',
          text: current ? current.label : '',
          tipKey: 'filter',
          style: styles.tipAnchor,
          probe: () => (props.renderValue === undefined ? isEllipsized(valueRef.current) : false),
        }, trigger),
        open
          ? h('div', {
            style: {
              ...styles.filterMenu,
              ...menuPos
                ? {
                  position: 'fixed',
                  left: `${menuPos.left}px`,
                  top: `${menuPos.top}px`,
                  width: `${menuPos.width}px`,
                  // fixed 定位时 min-width:100% 会按**视口**算 → 面板被撑满整屏，必须显式归零。
                  minWidth: '0px',
                  maxHeight: `${menuPos.maxHeight}px`,
                  overflowY: 'auto',
                }
                : {},
            },
            role: 'listbox',
          },
            props.options.map((item) => {
              const selected = item.value === props.value
              return h('button', {
                key: item.value,
                type: 'button',
                role: 'option',
                className: MENU_ITEM_CLASS,
                'aria-selected': selected ? 'true' : 'false',
                'aria-disabled': item.disabled === true ? 'true' : 'false',
                'data-option-value': item.value,
                'data-selected': selected ? 'true' : 'false',
                // 选中项**只靠右侧的对勾**区分，不加底色——背景色留给"鼠标悬停/键盘高亮"，
                // 两者叠在一起会分不清是选中还是悬停（用户指出过）。
                style: { ...styles.filterItem, ...item.disabled === true && !selected ? styles.popRowOff : {} },
                onClick: () => {
                  if (item.disabled === true) return
                  pick(item.value)
                },
              },
                h('span', { style: styles.filterItemText }, item.label),
                item.note ? h('span', { style: { ...styles.popRowNote, marginLeft: '6px' } }, item.note) : null,
                selected ? h(CheckIcon, { size: 14 }) : null)
            }))
          : null)
    }

    /**
     * 下拉里的小箭头（DSH 的 chevron：展开时整体转 180°）。
     * @param {{size?: number, className?: string}} props 属性。
     * @returns {any} 元素。
     */
    function ChevronIcon(props) {
      const size = (props && props.size) || 14
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        className: props.className,
        style: { flex: 'none', marginLeft: 'auto', transition: 'transform .12s' },
      }, h('path', {
        d: 'M4 6.2 8 10.2l4-4',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /**
     * 已选项右侧的对勾。
     * @param {{size?: number}} props 属性。
     * @returns {any} 元素。
     */
    function CheckIcon(props) {
      const size = (props && props.size) || 14
      return h('svg', {
        width: size, height: size, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
        style: { flex: 'none' },
      }, h('path', {
        d: 'M2.8 7.3l2.6 2.6 5.8-5.8',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /**
     * 开关（照抄 DSH 的 `Switch`：`button[role=switch][aria-checked]` + 一个滑块 span）。
     *
     * `title`（例如"为什么不能拨"的解释）走 DSH 气泡，不用原生 title。
     * 另外：**禁用的按钮在部分浏览器里不发鼠标事件**，所以锚点包在外面那层 span 上，
     * 这样禁用状态下也能看到解释。
     * @param {{checked: boolean, disabled?: boolean, title?: string, onChange?: Function}} props 属性。
     * @returns {any} 元素。
     */
    function SkillSwitch(props) {
      const button = h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'data-skill-switch': props.checked ? 'on' : 'off',
        className: SWITCH_CLASS,
        disabled: props.disabled === true,
        onClick: (event) => {
          event.stopPropagation()
          if (props.disabled === true) return
          if (props.onChange) props.onChange(!props.checked)
        },
      }, h('span', { className: SWITCH_THUMB_CLASS }))
      if (!props.title) return button
      return h(HoverBubble, { tag: 'span', text: props.title, tipKey: 'switch', style: styles.tipAnchor }, button)
    }

    /**
     * DSH 风格的空心垃圾桶图标（加载条目的「卸载」按钮上用同款字形）。
     * @param {{size?: number}} props 属性。
     * @returns {any} 元素。
     */
    function TrashIcon(props) {
      const size = (props && props.size) || 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        strokeWidth: ICON_STROKE, stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M2.6 4.4h10.8' }),
        h('path', { d: 'M6.2 4.4V3.1c0-.4.3-.7.7-.7h2.2c.4 0 .7.3.7.7v1.3' }),
        h('path', { d: 'M4.1 4.4l.55 8.1c0 .5.4.9.9.9h4.9c.5 0 .9-.4.9-.9l.55-8.1' }),
        h('path', { d: 'M6.7 7v4.1' }),
        h('path', { d: 'M9.3 7v4.1' }))
    }

    /**
     * 扫描根标签（下拉框与卡片共用）。
     * @param {Array<object>} roots 根列表。
     * @returns {(id: string) => string} 取标签。
     */
    function rootLabeler(roots) {
      const byId = new Map((roots || []).map((root) => [root.id, root]))
      return (id) => {
        const root = byId.get(id)
        return root ? root.label || root.id : id || '-'
      }
    }

    /**
     * 开关该长什么样：`{ checked, disabled, title }`。
     *
     * **开关的"开"必须等于"这个技能现在真的生效"**，不能只看两个调用标记：
     * 校验失败（`valid:false`）或被遮蔽（`effective:false`）的技能，就算标记写着"开"，
     * DSH 也根本不会用它；之前直接按标记显示，就出现了"灰轨道 + 滑块在右边"这种
     * 看起来既是开又是关的观感（用户拿截图问过一次）。
     * @param {object} skill 技能。
     * @returns {{checked: boolean, disabled: boolean, title: string}} 状态。
     */
    function switchState(skill) {
      const readonly = skill.providerOnly === true || skill.rootId === 'plugin'
      if (readonly) return { checked: false, disabled: true, title: t('statusProvider') }
      if (skill.valid === false) return { checked: false, disabled: true, title: t('switchLockedInvalid') }
      if (skill.effective === false) return { checked: false, disabled: true, title: t('switchLockedShadowed') }
      const enabled = skillEnabled(skill)
      return { checked: enabled, disabled: false, title: enabled ? t('switchOff') : t('switchOn') }
    }

    /**
     * 技能是否处于"启用"状态。
     *
     * DSH 的技能没有单一 `enabled` 字段，停用要两个 frontmatter 标记一起写：
     * `disable-model-invocation`（模型不许调用）与 `user-invocable: false`（`/` 菜单里不列）。
     * 卡片上那一个开关就绑在这件事上：**开 = 两个标记都不写，关 = 两个都写**；
     * 只有一个为开时仍算"开"（比如"只允许用户调用"的技能还能用）。
     * @param {object} skill 技能。
     * @returns {boolean} 是否启用。
     */
    function skillEnabled(skill) {
      const invocation = skill.invocation || {}
      return invocation.modelInvocable !== false || invocation.userInvocable !== false
    }

    /**
     * 标签配色：同一段文字永远拿到同一个颜色，不同目录/分类颜色不同。
     * 8 组色相（都挑的中低饱和，跟 DSH 的 Tag 观感接近）；底色用 `color-mix` 半透明，
     * 这样深色主题下也不会出现"浅底深字"的刺眼块。
     */
    const CHIP_HUES = [214, 262, 172, 28, 352, 122, 322, 196]

    /**
     * 由文字算一个稳定的色相。
     * @param {string} seed 文字。
     * @returns {number} 色相（0-360）。
     */
    function chipHue(seed) {
      let hash = 0
      const text = String(seed || '')
      for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) % 100000
      }
      return CHIP_HUES[hash % CHIP_HUES.length]
    }

    /**
     * 一个小标签（技能目录 / 分类共用）：圆角、11px、半透明同色底。
     *
     * 悬浮提示：**不用原生 `title`**（系统灰底样式跟 DSH 对不上），改成 DSH 气泡；
     * 而且只在标签**真的被省略**时才出现（没省略就没什么可看的）。
     * @param {{text: string, kind?: string, title?: string}} props 属性。
     * @returns {any} 元素。
     */
    function Chip(props) {
      const hue = chipHue(`${props.kind || ''}:${props.text}`)
      // 饱和度抬高（用户要"稍微高一点"）：字 75%、底 20% 同色。
      const ink = `hsl(${hue} 75% 38%)`
      const fill = `hsl(${hue} 78% 46%)`
      return h(HoverBubble, {
        tag: 'span',
        text: props.text,
        probe: isEllipsized,
        tipKey: 'chip',
        style: {
          ...styles.chip,
          color: ink,
          background: `color-mix(in srgb, ${fill} 20%, transparent)`,
        },
        attrs: { 'data-sm-chip': props.kind || 'tag' },
      })
    }

    /**
     * 判断一个单行省略的元素**是否真的被截断**（只有截断才需要悬浮提示）。
     *
     * 单独抽出来是为了能测：jsdom 没有布局，`scrollWidth/clientWidth` 都是 0，
     * 用假对象就能覆盖"截断 / 没截断"两条分支。
     * @param {{scrollWidth?: number, clientWidth?: number}} element 元素。
     * @returns {boolean} 是否被截断。
     */
    function isEllipsized(element) {
      if (!element) return false
      const scroll = Number(element.scrollWidth) || 0
      const client = Number(element.clientWidth) || 0
      // 没有布局信息（jsdom、还没渲染）时一律当作"没截断"，不挂多余的提示。
      if (scroll === 0 || client === 0) return false
      // 留 1px 余量：不同字体/缩放下 scrollWidth 可能比 clientWidth 多一点点。
      return scroll > client + 1
    }

    /**
     * 卡片标题：永远一行 + 省略号；**只有真的被截断时**才在悬浮时给 DSH 风格的名称气泡，
     * 没截断就什么提示都不显示。
     *
     * 这里**不用原生 `title`**：原生 tooltip 的样式由浏览器画（灰底系统字体），
     * 和 DSH 的气泡完全不同，所以改成自绘气泡。
     * @param {{text: string}} props 属性。
     * @returns {any} 元素。
     */
    function CardTitle(props) {
      const nameRef = React.useRef(null)
      const [truncated, setTruncated] = React.useState(false)
      React.useEffect(() => {
        // 文本、窗口宽度、字体都可能改变结果，每次渲染后量一次（量的是真实 DOM）。
        setTruncated(isEllipsized(nameRef.current))
      }, [props.text])
      return h(HoverBubble, {
        tag: 'span',
        text: props.text,
        probe: isEllipsized,
        style: styles.cardTitle,
        tipKey: 'name',
        innerRef: nameRef,
        attrs: {
          'data-skill-name': props.text,
          'data-truncated': truncated ? 'true' : 'false',
        },
      })
    }

    /**
     * 判断一个纵向被裁掉的元素（介绍文字超过可视行数）要不要给悬浮提示。
     * 同样抽成纯函数方便测：jsdom 没有布局，`scrollHeight/clientHeight` 都是 0。
     * @param {{scrollHeight?: number, clientHeight?: number}} element 元素。
     * @returns {boolean} 内容是否超出可视高度。
     */
    function isVerticallyClipped(element) {
      if (!element) return false
      const scroll = Number(element.scrollHeight) || 0
      const client = Number(element.clientHeight) || 0
      if (scroll === 0 || client === 0) return false
      return scroll > client + 1
    }

    /**
     * 把气泡的坐标夹进视口：靠右边的卡片不能让气泡顶出右边，靠底部的也不能掉出下边。
     *
     * 单独抽成纯函数，方便直接测边界（jsdom 量不出真实尺寸，但可以喂数字进来）。
     * @param {{x: number, y: number, top: number}} anchor 触发元素的左/下边与上边。
     * @param {{width: number, height: number}} bubble 气泡尺寸。
     * @param {{width: number, height: number}} viewport 视口尺寸。
     * @returns {{left: number, top: number}} 夹好的坐标。
     */
    function clampTipPosition(anchor, bubble, viewport) {
      const margin = 8
      const gap = 6
      const maxLeft = Math.max(margin, (viewport.width || 0) - (bubble.width || 0) - margin)
      const left = Math.min(Math.max(margin, anchor.x), maxLeft)
      let top = anchor.y
      // 下面放不下就翻到触发元素上方；上方也放不下时才夹到视口里。
      const roomBelow = (viewport.height || 0) - margin
      if (bubble.height && anchor.y + bubble.height > roomBelow) {
        const above = anchor.top - bubble.height - gap
        top = above >= margin ? above : Math.max(margin, roomBelow - bubble.height)
      }
      return { left, top }
    }

    /**
     * DSH 风格的悬浮气泡（技能名与介绍共用）。
     *
     * 只有 `probe(触发元素)` 为真时才出现（名字看横向是否被省略、介绍看纵向是否被裁）；
     * 气泡 `position: fixed`（不会被卡片的 `overflow:hidden` 裁掉），出现后再量一次自身尺寸，
     * 把坐标夹进视口（靠右/靠底的卡片不会把气泡顶出屏幕外）。
     * @param {{tag?: string, text: string, probe?: Function, style?: object, tipKey: string,
     *   attrs?: object, innerRef?: object}} props 属性。
     * @returns {any} 元素。
     */
    function HoverBubble(props) {
      const ref = React.useRef(null)
      const bubbleRef = React.useRef(null)
      // `anchor` 是触发元素的坐标，`pos` 是夹进视口后的最终坐标。
      const [anchor, setAnchor] = React.useState(undefined)
      const [pos, setPos] = React.useState(undefined)
      const show = () => {
        if (props.probe && !props.probe(ref.current)) return
        const box = ref.current && ref.current.getBoundingClientRect ? ref.current.getBoundingClientRect() : undefined
        if (!box) return
        setAnchor({ x: box.left, y: box.bottom + 6, top: box.top })
      }
      const hide = () => {
        setAnchor(undefined)
        setPos(undefined)
      }
      React.useLayoutEffect(() => {
        if (!anchor) {
          setPos(undefined)
          return
        }
        const bubble = bubbleRef.current
        const viewport = {
          width: (typeof window !== 'undefined' && window.innerWidth) || 0,
          height: (typeof window !== 'undefined' && window.innerHeight) || 0,
        }
        const box = bubble && bubble.getBoundingClientRect ? bubble.getBoundingClientRect() : undefined
        const measured = { width: (box && box.width) || 0, height: (box && box.height) || 0 }
        // 还没有布局信息（jsdom / 首次测量失败）时，先按原始坐标摆着。
        if (!viewport.width || (!measured.width && !measured.height)) {
          setPos({ left: Math.max(8, anchor.x), top: anchor.y })
          return
        }
        setPos(clampTipPosition(anchor, measured, viewport))
      }, [anchor])
      const tag = props.tag || 'span'
      // 触发元素可以是纯文字（`props.text`），也可以是一个现成的元素（`props.children`，
      // 例如按钮 / 开关 —— 外面包一层 span 只负责挂 hover 事件）。
      const trigger = props.children === undefined ? props.text : props.children
      return h(React.Fragment, null,
        h(tag, {
          ref: (node) => {
            ref.current = node
            if (props.innerRef) props.innerRef.current = node
          },
          onMouseEnter: show,
          onMouseLeave: hide,
          style: props.style,
          ...props.attrs || {},
        }, trigger),
        anchor
          ? h('div', {
            ref: bubbleRef,
            style: {
              ...styles.tipBubble,
              // 个别气泡可以覆盖尺寸（例如卡片介绍的气泡只有默认宽度的一半）。
              ...props.bubbleStyle || {},
              left: `${(pos || { left: Math.max(8, anchor.x) }).left}px`,
              top: `${(pos || { top: anchor.y }).top}px`,
            },
            role: 'tooltip',
            'data-sm-tooltip': props.tipKey,
          }, props.text)
          : null)
    }

    /**
     * 介绍文字：**只在显示不全时**悬浮才出气泡（同 DSH 的 Tooltip 样式）。
     * @param {{text: string}} props 属性。
     * @returns {any} 元素。
     */
    function DescriptionTip(props) {
      return h(HoverBubble, {
        tag: 'div',
        text: props.text,
        probe: isVerticallyClipped,
        style: styles.cardDesc,
        tipKey: 'desc',
        // 用户要求：卡片介绍的气泡宽度缩到默认的一半（50vw → 25vw）。
        bubbleStyle: { maxWidth: '25vw' },
        attrs: { 'data-sm-card-desc': '1' },
      })
    }

    /**
     * 技能卡片。
     *
     * 自上而下的顺序（用户定的版式）：
     *   1. 技能名（不再带生效/无效状态）；
     *   2. `删除` `详情` `启停开关`，**右对齐**；
     *   3. 标签行（技能目录 / 分类），**左对齐**；
     *   4. 一条 0.5px 分割线；
     *   5. 分割线以下全是技能介绍。
     * @param {object} props 属性。
     * @returns {any} 元素。
     */
    function SkillCard(props) {
      const skill = props.skill
      const busy = props.busy
      // 插件内嵌技能没有可写的文件：只给「详情」，不给删/启停。
      const readonly = skill.providerOnly === true || skill.rootId === 'plugin'
      const toggle = switchState(skill)
      const categories = skillCategories(skill)
      const run = (event, task) => {
        event.stopPropagation()
        if (!busy) task()
      }
      return h('div', {
        style: { ...styles.card, ...props.open ? styles.cardOpen : {} },
        className: `${CARD_CLASS}${props.open ? ' dsh-sm-card-open' : ''}`,
        onClick: () => props.onOpen(skill),
        // 卡片根上**不挂 title**：否则鼠标悬浮在名字上会冒出整段介绍
        // （用户要求：名字没截断就什么提示都不显示）。
        'data-skill-card': skill.name,
      },
        // 第一行：技能名 + 启停开关（开关在这一行**右对齐**）。
        h('div', { style: styles.cardHead, 'data-sm-card-head': '1' },
          h(CardTitle, { text: skill.name }),
          readonly
            ? null
            : h(SkillSwitch, {
              checked: toggle.checked,
              disabled: busy || toggle.disabled,
              title: toggle.title,
              onChange: (next) => props.onToggle(skill, next),
            })),
        // 标签行（左对齐）→ 分割线 → 介绍。
        h('div', { style: styles.cardTags, 'data-sm-card-tags': '1' },
          h(Chip, { text: props.rootLabel(skill.rootId), kind: 'root', title: t('rootFilter') }),
          categories.length
            ? categories.map((name) => h(Chip, { key: name, text: name, kind: 'category', title: t('categoryFilter') }))
            : h(Chip, { text: t('uncategorized'), kind: 'category', title: t('categoryFilter') })),
        h('div', { style: styles.cardDivider, 'data-sm-card-divider': '1' }),
        h(DescriptionTip, { text: skill.description || '—' }),
        // 删除 / 详情：卡片最下方，右对齐。
        h('div', { style: styles.cardActions, 'data-sm-card-actions': '1' },
          readonly
            ? null
            : h(Btn, {
              variant: 'outline',
              className: `${COMPACT_CLASS} ${DANGER_CLASS}`,
              icon: h(TrashIcon, { size: 14 }),
              title: t('trash'),
              disabled: busy,
              onClick: (event) => run(event, () => props.onTrash(skill)),
            }, t('trash')),
          h(Btn, {
            variant: 'outline',
            className: COMPACT_CLASS,
            title: t('detail'),
            onClick: (event) => run(event, () => props.onOpen(skill)),
          }, t('detail'))))
    }

    /**
     * 详情页里的下拉浮层：点触发器打开，点外面 / Esc 关闭。
     *
     * 面板用 `position: fixed`：弹窗正文可能滚动或被裁剪，absolute 面板会被切掉。
     * @param {{open: boolean, onClose: Function, width?: number, name: string,
     *   trigger: any, children?: any}} props 属性。
     * @returns {any} 元素。
     */
    function PopMenu(props) {
      const anchorRef = React.useRef(null)
      const [pos, setPos] = React.useState(undefined)
      React.useLayoutEffect(() => {
        if (!props.open) {
          setPos(undefined)
          return
        }
        const node = anchorRef.current
        if (!node || typeof node.getBoundingClientRect !== 'function') return
        const box = node.getBoundingClientRect()
        const width = props.width || 240
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 0
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 0
        const left = Math.max(8, Math.min(box.right - width, Math.max(8, vw - width - 8)))
        // 下方放不下就翻到触发器上方（否则面板会伸出屏幕外）。
        const belowTop = box.bottom + 4
        const roomBelow = vh - belowTop - 12
        const top = roomBelow >= 200 ? belowTop : Math.max(8, box.top - 204)
        setPos({
          left,
          top,
          width,
          maxHeight: Math.max(120, Math.min(320, vh - top - 12)),
        })
      }, [props.open, props.width])
      React.useEffect(() => {
        if (!props.open) return undefined
        const onDown = (event) => {
          const node = anchorRef.current
          if (node && node.contains(event.target)) return
          props.onClose()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') props.onClose()
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [props.open, props.onClose])
      return h('span', { ref: anchorRef, style: styles.editValue },
        props.trigger,
        props.open && pos
          ? h('div', {
            style: {
              ...styles.popMenu,
              left: `${pos.left}px`,
              top: `${pos.top}px`,
              width: `${pos.width}px`,
              maxHeight: `${pos.maxHeight}px`,
            },
            role: 'listbox',
            'aria-multiselectable': props.multi === true ? 'true' : undefined,
            'data-sm-pop': props.name,
          }, props.children)
          : null)
    }

    /**
     * 一支小铅笔（分类改名用）。
     * @param {{size?: number}} props 属性。
     * @returns {any} 元素。
     */
    function PencilIcon(props) {
      const size = (props && props.size) || 12
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M11.2 2.6l2.2 2.2-7.6 7.6-3 .8.8-3z' }))
    }

    /**
     * 技能详情**弹窗**。
     *
     * 信息区是 DSH 插件详情那套 facts 列表；**只有两处可改**（用户定的）：
     *   1. 技能目录：单选，点「确定」才把技能搬到目标根；
     *   2. 分类：多选，可勾选/反选、新增、改名，最多 5 个，写进 `metadata.category`（逗号分隔）。
     * 底部是 `取消`（描边）+ `确定`（实心黑，**有改动才可点**）；`查看 SKILL.md` 留在左侧。
     *
     * @param {object} props 属性。
     * @returns {any} 元素。
     */
    function SkillDetailDialog(props) {
      const skill = props.skill
      const file = props.file
      const roots = Array.isArray(props.roots) ? props.roots : []
      const initialCategories = React.useMemo(() => skillCategories(skill), [skill])
      const [rootId, setRootId] = React.useState(skill.rootId)
      const [categories, setCategories] = React.useState(initialCategories)
      // 下拉里可选的分类：本技能现有的 + 目录里其他技能用过的（去重）。
      const [options, setOptions] = React.useState(() => {
        const out = [...initialCategories]
        for (const name of Array.isArray(props.allCategories) ? props.allCategories : []) {
          if (!out.includes(name)) out.push(name)
        }
        return out
      })
      const [catOpen, setCatOpen] = React.useState(false)
      const [renaming, setRenaming] = React.useState(undefined)
      const [hint, setHint] = React.useState('')
      // 新增 / 改名用**非受控**输入框（读 ref 的当前值）：受控框在合成事件之外
      // 很难驱动，非受控更稳，而且这里本来也不需要"边打字边校验"。
      const draftRef = React.useRef(null)
      const renameRef = React.useRef(null)

      const rootChanged = rootId !== skill.rootId
      const categoryChanged = !sameCategories(categories, initialCategories)
      const dirty = rootChanged || categoryChanged
      // 文件已经展开时，这个按钮变成「收起」——否则点了只会在下面又铺一遍内容。
      const showing = file !== undefined

      const toggleCategory = (name) => {
        setHint('')
        if (categories.includes(name)) {
          setCategories(categories.filter((item) => item !== name))
          return
        }
        if (categories.length >= MAX_CATEGORIES) {
          setHint(t('categoryLimit'))
          return
        }
        setCategories([...categories, name])
      }

      /** 新增一个分类（来自输入框）。 */
      const addCategory = () => {
        const input = draftRef.current
        const value = String(input ? input.value : '').trim()
        if (value === '') return
        if (value.includes(',')) {
          setHint(t('categoryComma'))
          return
        }
        if (value.length > 40) {
          setHint(t('categoryLimit'))
          return
        }
        if (categories.includes(value)) {
          setHint(t('categoryDup'))
          return
        }
        if (categories.length >= MAX_CATEGORIES) {
          setHint(t('categoryLimit'))
          return
        }
        setCategories([...categories, value])
        setOptions((list) => (list.includes(value) ? list : [...list, value]))
        if (input) input.value = ''
        setHint('')
      }

      /** 提交改名：同步改"当前选中项"和"可选列表"。 */
      const commitRename = (from) => {
        const input = renameRef.current
        const to = String(input ? input.value : '').trim()
        setRenaming(undefined)
        if (to === '' || to === from) return
        if (to.includes(',')) {
          setHint(t('categoryComma'))
          return
        }
        if (options.includes(to)) {
          setHint(t('categoryDup'))
          return
        }
        setCategories((list) => list.map((item) => (item === from ? to : item)))
        setOptions((list) => list.map((item) => (item === from ? to : item)))
        setHint('')
      }

      const rows = [
        [t('path'), skill.path || '-'],
        [t('provider'), skill.provider || '-'],
        [t('details'), skill.description || '-'],
        [t('resources'), Array.isArray(skill.resources) && skill.resources.length
          ? skill.resources.map((item) => `${item.path}${item.bytes === undefined ? '' : ` (${item.bytes}B)`}`).join('、')
          : skill.resources && typeof skill.resources === 'object' && skill.resources.files !== undefined
            ? `${skill.resources.files} files${skill.resources.bytes === undefined ? '' : ` / ${skill.resources.bytes} bytes`}`
              + (Array.isArray(skill.resources.directories) && skill.resources.directories.length ? ` · ${skill.resources.directories.join('、')}` : '')
            : '-'],
      ]
      if (skill.shadowedBy) {
        rows.push([t('statusShadowed'), `${skill.shadowedBy.rootLabel || ''} ${skill.shadowedBy.path || ''}`.trim()])
      }
      if (skill.metadata && Object.keys(skill.metadata).length) {
        rows.push(['metadata', Object.entries(skill.metadata).map(([key, value]) => `${key}: ${value}`).join('、')])
      }

      // ① 技能目录（单选）：值显示成和卡片一样的彩色标签，下拉用**和筛选器同一个组件**。
      const rootRow = h('div', { key: 'edit-root', 'data-sm-edit': 'root' },
        h('dt', null, t('rootFilter')),
        h('dd', null,
          h(FilterSelect, {
            name: 'detail-root',
            value: rootId,
            disabled: props.busy,
            onChange: (value) => setRootId(value),
            options: roots.map((root) => {
              const disabled = root.writable === false || root.exists === false
              return {
                value: root.id,
                label: root.label || root.id,
                disabled,
                note: disabled ? t('rootReadonly') : undefined,
              }
            }),
          })))

      // ② 分类（多选）：勾选 / 反选、新增、改名，最多 5 个。
      const categoryRow = h('div', { key: 'edit-category', 'data-sm-edit': 'category' },
        h('dt', null, t('categories')),
        h('dd', null,
          h(PopMenu, {
            open: catOpen,
            onClose: () => setCatOpen(false),
            width: 240,
            multi: true,
            name: 'category',
            // 触发器做成**和单选下拉一样的字段框**：框里是逗号分隔的分类文本。
            trigger: h('div', { className: FIELD_CLASS, style: styles.filterField, 'data-sm-multi': 'category' },
              h('button', {
                type: 'button',
                className: SELECT_CLASS,
                style: styles.filterTrigger,
                'aria-haspopup': 'listbox',
                'aria-expanded': catOpen ? 'true' : 'false',
                'data-sm-multi-trigger': 'category',
                disabled: props.busy,
                onClick: () => setCatOpen(!catOpen),
              },
                h('span', { style: styles.filterValue, 'data-sm-multi-value': 'category' },
                  categories.length ? categories.join(', ') : '-'),
                h(ChevronIcon, { size: 14, className: 'dsh-sm-chevron' }))),
          },
            options.length === 0 ? h('div', { style: styles.popHint }, t('pickCategory')) : null,
            options.map((option) => {
              const selected = categories.includes(option)
              const full = !selected && categories.length >= MAX_CATEGORIES
              if (renaming === option) {
                return h('div', { key: `edit-${option}`, className: 'dsh-sm-pop-row', style: styles.popRow },
                  h('span', { style: { ...styles.popCheck, ...selected ? styles.popCheckOn : {} } }, selected ? h(CheckIcon, { size: 12 }) : null),
                  h('input', {
                    ref: renameRef,
                    style: styles.popInput,
                    defaultValue: option,
                    autoFocus: true,
                    'data-sm-rename-input': option,
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') commitRename(option)
                      if (event.key === 'Escape') setRenaming(undefined)
                    },
                    onBlur: () => commitRename(option),
                    onClick: (event) => event.stopPropagation(),
                  }))
              }
              return h('div', {
                key: option,
                role: 'option',
                className: 'dsh-sm-pop-row',
                'aria-selected': selected ? 'true' : 'false',
                'aria-disabled': full ? 'true' : 'false',
                'data-sm-category-option': option,
                style: { ...styles.popRow, ...full ? styles.popRowOff : {} },
                onClick: () => toggleCategory(option),
              },
                h('span', { style: { ...styles.popCheck, ...selected ? styles.popCheckOn : {} } }, selected ? h(CheckIcon, { size: 12 }) : null),
                h('span', { style: styles.popRowText }, option),
                h('button', {
                  type: 'button',
                  className: 'dsh-sm-iconbtn',
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '20px',
                    height: '20px',
                    padding: 0,
                    border: 'none',
                    borderRadius: '6px',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary, inherit)',
                    cursor: 'pointer',
                    flex: 'none',
                  },
                  'data-sm-rename': option,
                  'aria-label': `${t('renameCategory')}：${option}`,
                  onClick: (event) => {
                    event.stopPropagation()
                    setRenaming(option)
                    setRenameText(option)
                  },
                }, h(PencilIcon, { size: 12 })))
            }),
            h('div', { style: { borderTop: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))', margin: '4px 0' } }),
            h('div', { style: { ...styles.popRow, cursor: 'default', paddingRight: '2px' } },
              h('input', {
                ref: draftRef,
                style: styles.popInput,
                defaultValue: '',
                placeholder: t('newCategory'),
                'data-sm-new-category': '1',
                onKeyDown: (event) => {
                  if (event.key === 'Enter') addCategory()
                },
              }),
              h(Btn, {
                variant: 'outline',
                className: COMPACT_CLASS,
                style: { flex: 'none' },
                disabled: props.busy || categories.length >= MAX_CATEGORIES,
                onClick: addCategory,
              }, t('addOne'))),
            h('div', { style: styles.popHint }, hint || `${categories.length}/${MAX_CATEGORIES}`))))

      // 底部：左「查看 / 收起 SKILL.md」，右「取消 / 确定」（有改动才可点）。
      const footer = h('div', { style: { ...styles.row, width: '100%' } },
        h(Btn, {
          variant: 'outline',
          className: COMPACT_CLASS,
          onClick: () => (showing ? props.onHide() : props.onRead(skill)),
          disabled: props.busy,
        }, showing ? t('hideFile') : t('viewFile')),
        h('span', { style: styles.spacer }),
        // 这句提示放在「取消」左边（用户要求），说明只有点确定才生效。
        h('span', {
          style: { ...styles.muted, marginRight: '8px', textAlign: 'right' },
          'data-sm-edit-hint': '1',
        }, t('editHint')),
        h(Btn, {
          variant: 'outline',
          className: COMPACT_CLASS,
          disabled: props.busy,
          onClick: () => props.onClose(),
        }, t('cancel')),
        h(Btn, {
          variant: 'primary',
          className: COMPACT_CLASS,
          disabled: props.busy || !dirty,
          'data-sm-save': dirty ? 'on' : 'off',
          onClick: () => props.onSave(skill, { rootId, categories }),
        }, t('ok')))

      const body = [
        // 信息区用 DSH 插件详情那套 facts：左右两端对齐、行间 0.5px 细线。
        h('dl', { key: 'facts', className: FACTS_CLASS }, [
          rootRow,
          categoryRow,
          ...rows.flatMap(([key, value], index) => [
            h('div', { key: `f${index}` },
              h('dt', null, key),
              h('dd', null, typeof value === 'string' ? String(value) : value)),
          ]),
        ]),
        file !== undefined ? h('pre', { key: 'file', style: styles.pre }, file) : null,
      ]

      if (UI && UI.Modal) {
        return h(UI.Modal, {
          open: true,
          onClose: props.onClose,
          title: skill.name,
          closeLabel: t('close'),
          // 详情信息多，用宽版：默认弹窗宽度约 400px 级，这里放大到"铺满内容区"。
          className: WIDE_DIALOG_CLASS,
          footer,
        }, body)
      }
      return h('div', { style: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget) props.onClose() } },
        h('div', { style: styles.dialogWide },
          h('div', { style: styles.row },
            // 标题字号照 DSH 的 `detailTitle`（20px / 500 / 28px）。
            h('div', { style: { ...styles.cardTitle, fontSize: '20px', fontWeight: 500, lineHeight: '28px' } }, skill.name),
            h('span', { style: styles.spacer }),
            h(CloseButton, { onClick: props.onClose })),
          body,
          footer))
    }

    /**
     * 确认弹窗（删除技能用）：DSH 卸载插件的那个确认框 —— 描边的「取消」+ **实心红**的确认。
     * @param {{title: string, description: string, confirmLabel: string, busy?: boolean,
     *   onCancel: Function, onConfirm: Function}} props 属性。
     * @returns {any} 元素。
     */
    function ConfirmDialog(props) {
      const footer = h('div', { style: styles.row },
        h(Btn, { variant: 'outline', onClick: props.onCancel, disabled: props.busy }, t('cancel')),
        h(Btn, {
          variant: 'primary',
          className: DANGER_SOLID_CLASS,
          onClick: props.onConfirm,
          disabled: props.busy,
        }, props.confirmLabel))
      if (UI && UI.Modal) {
        // 不带宽版类名：DSH 自己的卸载确认框就是默认宽度（min(380px,100%)）。
        return h(UI.Modal, {
          open: true,
          onClose: props.onCancel,
          title: props.title,
          closeLabel: t('close'),
          footer,
          // 说明文字放在正文里（而不是 `description` 属性）：两种弹窗实现下都能看到。
        }, h('div', { style: styles.muted }, props.description))
      }
      return h('div', { style: { ...styles.overlay, zIndex: 1100 } },
        h('div', { style: styles.dialogConfirm },
          h('div', { style: styles.row },
            h('div', { style: styles.title }, props.title),
            h('span', { style: styles.spacer }),
            h(CloseButton, { onClick: props.onCancel })),
          h('div', { style: styles.muted }, props.description),
          footer))
    }

    /**
     * 云朵上传图标（拖拽导入区用；DSH 图标集里没有 upload，这里自绘一个同风格的）。
     * @param {{size?: number}} props 属性。
     * @returns {any} 元素。
     */
    function UploadCloudIcon(props) {
      const size = (props && props.size) || 44
      return h('svg', {
        width: size, height: size, viewBox: '0 0 48 48', fill: 'none', 'aria-hidden': 'true',
        strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', {
          d: 'M16 34h16.5a7.5 7.5 0 0 0 .6-14.98A10.5 10.5 0 0 0 13.2 19.4 7.3 7.3 0 0 0 16 34Z',
          stroke: 'currentColor',
        }),
        h('path', { d: 'M24 39V25.5', stroke: 'currentColor' }),
        h('path', { d: 'M19.6 29.9 24 25.5l4.4 4.4', stroke: 'currentColor' }))
    }

    /**
     * 把二进制内容编码成 base64（分块，避免大文件把调用栈撑爆）。
     * @param {Uint8Array} bytes 内容。
     * @returns {string} base64。
     */
    function toBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let at = 0; at < bytes.length; at += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(at, at + chunk))
      }
      const btoa = (typeof window !== 'undefined' && window.btoa) ? window.btoa.bind(window) : undefined
      return btoa ? btoa(binary) : Buffer.from(bytes).toString('base64')
    }

    /**
     * 递归收集拖进来的文件（目录用 `webkitGetAsEntry` 展开）。
     * @param {DataTransfer} transfer 拖放数据。
     * @returns {Promise<Array<{path: string, data: string}>>} 文件列表。
     */
    async function collectDropped(transfer) {
      const results = []
      /**
       * 读一个文件。
       * @param {File} file 文件。
       * @param {string} prefix 目录前缀。
       * @returns {Promise<void>} 无。
       */
      const readFile = async (file, prefix) => {
        const bytes = new Uint8Array(await file.arrayBuffer())
        results.push({ path: prefix ? `${prefix}/${file.name}` : file.name, data: toBase64(bytes) })
      }
      /**
       * 递归展开一个 entry。
       * @param {any} entry FileSystemEntry。
       * @param {string} prefix 目录前缀。
       * @returns {Promise<void>} 无。
       */
      const walk = async (entry, prefix) => {
        if (!entry) return
        if (entry.isFile) {
          const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
          await readFile(file, prefix)
          return
        }
        if (!entry.isDirectory) return
        const next = prefix ? `${prefix}/${entry.name}` : entry.name
        const reader = entry.createReader()
        for (;;) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
          if (!batch || batch.length === 0) break
          for (const child of batch) await walk(child, next)
        }
      }

      const items = transfer && transfer.items ? Array.from(transfer.items) : []
      for (const item of items) {
        if (item.kind !== 'file') continue
        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : undefined
        if (entry) {
          await walk(entry, '')
          continue
        }
        const file = typeof item.getAsFile === 'function' ? item.getAsFile() : undefined
        if (file) await readFile(file, '')
      }
      if (results.length === 0 && transfer && transfer.files) {
        for (const file of Array.from(transfer.files)) await readFile(file, '')
      }
      return results
    }

    /**
     * 导入本地的对话框：**只有两件事**——
     *   1. 把技能文件夹（或单个 `.md`）拖进来，松手即导入；
     *   2. 点击 → 浏览本机目录 → 选中即导入。
     * 界面上只显示"这次导入/选择的路径"和一行结果，不放目标根、覆盖、兜底按钮这些杂物。
     * 目标技能根用上次选过的那个（默认优先用户级根），在设置页可以改。
     *
     * @param {object} props 属性。
     * @returns {any} 元素。
     */
    function ImportDialog(props) {
      // 已选中的导入来源：选目录/拖拽只是"选中"，点「导入」才真的导入。
      const [pending, setPending] = React.useState(undefined)
      const [listing, setListing] = React.useState(undefined)
      // 只有**用户点了之后**才出现目录列表（系统选择框不可用时的兜底浏览）。
      const [browsing, setBrowsing] = React.useState(false)
      // 同名冲突：弹出确认框问是否覆盖，而不是偷偷覆盖或用原生 confirm。
      const [conflict, setConflict] = React.useState(undefined)
      const [message, setMessage] = React.useState('')
      // 这条提示是"出错了"还是"成功了"：出错要标红（用户要求问题内容标红）。
      const [failed, setFailed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      const [done, setDone] = React.useState(false)

      /** 清掉上一条提示。 */
      const clearMessage = () => {
        setMessage('')
        setFailed(false)
      }
      /** 报错：标红。 */
      const reportError = (error) => {
        setMessage(String(error.message || error))
        setFailed(true)
      }

      const browse = React.useCallback(async (next) => {
        setBusy(true)
        setMessage('')
        setFailed(false)
        try {
          const result = await call(`${ROUTE.browse}?path=${encodeURIComponent(next || '')}`)
          if (!result.ok) throw new Error(result.error || 'browse failed')
          setListing(result)
        } catch (error) {
          setMessage(String(error.message || error))
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }, [])

      /**
       * 选中一个导入来源（点选目录、拖拽、列表点选都走这里）。
       *
       * 必须把 `done` 复位：导入成功之后按钮会置灰防止重复点，此时用户再选一个文件夹，
       * 如果不复位，按钮就一直是灰的、导入不了（就是用户报的"导入按钮不能点"）。
       *
       * @param {{kind: 'path'|'files', source?: string, files?: Array<object>, label?: string}} attempt 选中内容。
       * @returns {void}
       */
      const choose = (attempt) => {
        setPending(attempt)
        setDone(false)
        clearMessage()
      }

      /** 从选择结果里取出路径（preload 桥与服务两种返回形状都吃）。 */
      const pathOf = (value) => {
        if (typeof value === 'string') return value
        if (value && typeof value === 'object') {
          if (typeof value.path === 'string') return value.path
          if (typeof value.value === 'string') return value.value
          if (value.value && typeof value.value.path === 'string') return value.value.path
        }
        return ''
      }

      /**
       * 真正发起一次导入。`attempt` 决定走"本地路径"还是"拖拽上传"两条通道；
       * 返回"目标已存在"时不直接失败，而是挂起一个冲突确认框。
       * @param {{kind: 'path'|'files', source?: string, files?: Array<object>, label?: string}} attempt 本次导入。
       * @param {boolean} overwrite 是否覆盖同名目标。
       * @returns {Promise<void>} 无。
       */
      const runImport = async (attempt, overwrite) => {
        if (!attempt) return
        setBusy(true)
        clearMessage()
        try {
          const caught = attempt.kind === 'files'
            ? await call(ROUTE.importUpload, {
              method: 'POST',
              body: { cwd: props.cwd, rootId: props.rootId, files: attempt.files, overwrite },
            })
            : await call(ROUTE.action, {
              method: 'POST',
              body: { action: 'import', cwd: props.cwd, rootId: props.rootId, sourcePath: attempt.source, overwrite },
            })
          if (!caught.ok) {
            const text = String(caught.error || 'import failed')
            if (!overwrite && text.includes('目标已存在')) {
              const name = (text.split('：')[1] || attempt.label || '').trim()
              setConflict({ attempt, name })
              return
            }
            throw new Error(text)
          }
          setMessage(`${t('importDone')}：${caught.name} → ${props.rootLabel}`)
          setFailed(false)
          setDone(true)
          props.onImported?.(caught.name)
          props.onDone()
        } catch (error) {
          reportError(error)
        } finally {
          setBusy(false)
        }
      }

      /** 拖进来的内容先存着（浏览器拿不到本地路径，只能稍后把内容传上去）。 */
      const dropFiles = async (transfer) => {
        setBusy(true)
        clearMessage()
        try {
          const files = await collectDropped(transfer)
          if (files.length === 0) throw new Error(t('dropEmpty'))
          const label = files.length === 1 ? files[0].path : `${files[0].path.split('/')[0]}/…（${files.length} 个文件）`
          choose({ kind: 'files', files, label })
        } catch (error) {
          reportError(error)
        } finally {
          setBusy(false)
        }
      }

      /** 点击：优先系统选目录，选完**只显示路径**，等用户点「导入」；不可用时展开本机目录列表。 */
      const clickZone = async () => {
        clearMessage()
        if (!props.hasPicker || !props.hasPicker()) {
          setBrowsing(true)
          if (!listing) browse('')
          return
        }
        try {
          const picked = await props.pickDirectory()
          const value = pathOf(picked)
          if (value) choose({ kind: 'path', source: value, label: value })
        } catch (error) {
          if (error && error.code === 'PICKER_UNAVAILABLE') {
            setBrowsing(true)
            if (!listing) browse('')
            return
          }
          // 系统弹窗被取消：安静收场。
        }
      }

      const zone = h('div', {
        key: 'zone',
        style: { ...styles.dropzone, ...dragging ? styles.dropzoneActive : {} },
        onClick: () => { void clickZone() },
        onDragOver: (event) => { event.preventDefault(); setDragging(true) },
        onDragEnter: (event) => { event.preventDefault(); setDragging(true) },
        onDragLeave: () => setDragging(false),
        onDrop: (event) => {
          event.preventDefault()
          setDragging(false)
          void dropFiles(event.dataTransfer)
        },
        role: 'button',
        tabIndex: 0,
      },
        h('div', { style: { color: 'var(--dsw-alias-text-tertiary, currentColor)', opacity: 0.5 } }, h(UploadCloudIcon, null)),
        h('div', { style: styles.dropTitle }, busy ? t('importing') : t('dropHint')),
        h('div', { style: styles.muted }, t('dropClickHint')))

      const body = [
        zone,
        pending
          ? h(HoverBubble, {
            key: 'picked',
            tag: 'div',
            text: pending.label,
            tipKey: 'path',
            style: styles.pickedPath,
            probe: isEllipsized,
          })
          : null,
        browsing && !props.hasPicker?.()
          ? h('div', { key: 'browser', style: styles.browseList },
            listing && listing.entries && listing.entries.length
              ? listing.entries.map((entry) => h(HoverBubble, {
                key: entry.path,
                tag: 'div',
                text: entry.path,
                tipKey: 'path',
                probe: isEllipsized,
                style: { ...styles.browseRow, ...entry.hasSkill ? { fontWeight: 600 } : {} },
                attrs: {
                  onClick: () => {
                    if (entry.kind === 'directory' && !entry.hasSkill) { void browse(entry.path); return }
                    choose({ kind: 'path', source: entry.path, label: entry.path })
                  },
                },
              },
                h('span', null, entry.kind === 'directory' ? '📁' : '📄'),
                h('span', { style: styles.browseName }, entry.name),
                entry.hasSkill ? h(Tag, { tone: 'ok' }, 'SKILL.md') : null))
              : h('div', { key: 'empty', style: { ...styles.muted, padding: '10px 12px' } }, busy ? t('browsing') : t('nothingHere')))
          : null,
        h('div', { key: 'actions', style: styles.row },
          // 「导入到」目标技能根可自己选（默认记住上次的选择，优先用户级根）。
          // 用自绘下拉：原生 select 的弹出面板是系统样式，跟 DSH 不一致。
          h(FilterSelect, {
            name: 'import-root',
            label: t('importTarget'),
            value: props.rootId,
            onChange: (value) => props.onRootChange?.(value),
            options: (props.roots || []).map((root) => ({ value: root.id, label: root.label || root.id })),
          }),
          h('span', { style: styles.spacer }),
          // 「导入」：选中之后由用户点这一下才真的导入。
          h(Btn, {
            variant: 'primary',
            onClick: () => { void runImport(pending, false) },
            disabled: busy || !pending || done,
            title: t('importGo'),
          }, busy ? t('importing') : t('importGo'))),
        message ? h('div', { key: 'message', 'data-sm-import-message': failed ? 'error' : 'ok', style: failed ? styles.error : styles.muted }, message) : null,
      ]

      /** 同名覆盖确认框（叠在导入弹窗之上）。 */
      const confirmDialog = conflict
        ? (() => {
          const ask = `${conflict.name || ''} ${t('conflictAsk')}`
          const footer = h('div', { style: styles.row },
            h(Btn, { variant: 'ghost', onClick: () => setConflict(undefined) }, t('cancel')),
            h(Btn, { variant: 'primary', onClick: () => { const attempt = conflict.attempt; setConflict(undefined); void runImport(attempt, true) } }, t('overwrite')))
          if (UI && UI.Modal) {
            return h(UI.Modal, {
              open: true,
              onClose: () => setConflict(undefined),
              title: t('conflictTitle'),
              closeLabel: t('close'),
              description: ask,
              className: IMPORT_DIALOG_CLASS,
              footer,
            })
          }
          return h('div', { style: { ...styles.overlay, zIndex: 1100 } },
            h('div', { style: styles.dialog },
              h('div', { style: styles.row },
                h('div', { style: styles.title }, t('conflictTitle')),
                h('span', { style: styles.spacer }),
                h(CloseButton, { onClick: () => setConflict(undefined) })),
              h('div', { style: styles.muted }, ask),
              footer))
        })()
        : null

      const main = (UI && UI.Modal)
        ? h(UI.Modal, {
          open: true,
          onClose: props.onClose,
          title: t('importTitle'),
          closeLabel: t('close'),
          description: t('importDesc'),
          className: IMPORT_DIALOG_CLASS,
        }, body)
        : h('div', { style: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget) props.onClose() } },
          h('div', { style: styles.dialog },
            h('div', { style: styles.row },
              h('div', { style: styles.title }, t('importTitle')),
              h('span', { style: styles.spacer }),
              h(CloseButton, { onClick: props.onClose })),
            h('div', { style: styles.muted }, t('importDesc')),
            body))

      return confirmDialog ? h(React.Fragment, null, main, confirmDialog) : main
    }

    /**
     * 已安装页：工具栏 + 卡片网格 + 详情。
     * @param {object} props 属性。
     * @returns {any} 元素。
     */
    function InstalledTab(props) {
      const catalog = props.catalog
      const [openName, setOpenName] = React.useState('')
      const [file, setFile] = React.useState(undefined)
      // 待确认删除的技能：卡片/详情里的「删除」只打开确认框，确认后才真删。
      const [pendingTrash, setPendingTrash] = React.useState(undefined)
      // 插件内嵌技能（provider）没有文件路径，单独归到「插件提供」这一档一起看。
      const providerSkills = (catalog.providerOnly || []).map((skill) => ({ ...skill, rootId: 'plugin', providerOnly: true }))
      const allSkills = [...providerSkills, ...(catalog.skills || [])]
      // 两级筛选依次收窄：先按技能目录（扫描根），再按 metadata.category。
      const rootSkills = allSkills.filter((skill) => props.rootFilter === '' || skill.rootId === props.rootFilter)
      // 分类选项跟着**当前技能目录**走（这就是"关联筛选"）：换了目录，分类下拉里
      // 只留这个目录下真出现过的分类，选中项若不在其中会自动清掉。
      const categoryCounts = new Map()
      let uncategorized = 0
      for (const skill of rootSkills) {
        const list = skillCategories(skill)
        if (list.length === 0) uncategorized += 1
        for (const name of list) categoryCounts.set(name, (categoryCounts.get(name) || 0) + 1)
      }
      const categoryOptions = [...categoryCounts.keys()].sort((left, right) => left.localeCompare(right))
      const activeCategory = props.categoryFilter === ''
        ? ''
        : props.categoryFilter === UNCATEGORIZED
          // 「未分类」也要在换了目录之后重新校验：新目录里可能有分类全齐、没有未分类的。
          ? (uncategorized > 0 ? UNCATEGORIZED : '')
          : (categoryCounts.has(props.categoryFilter) ? props.categoryFilter : '')
      // 选过的分类可能因为换了目录/删了技能而不存在了：清掉，别让界面卡在空列表。
      React.useEffect(() => {
        if (props.categoryFilter === '' || activeCategory === props.categoryFilter) return
        props.onCategoryFilter('')
      }, [props.categoryFilter, activeCategory])
      const skills = rootSkills.filter((skill) => {
        if (activeCategory === '') return true
        const list = skillCategories(skill)
        return activeCategory === UNCATEGORIZED ? list.length === 0 : list.includes(activeCategory)
      })
      // **反向联动**：选了分类之后，技能目录下拉只列"真的有这个分类"的目录，
      // 且条数是筛完之后的数量。否则"先选分类再选目录"时，用户会挑到一个没有该分类的目录，
      // 分类筛选被静默清掉——看起来就像"分类 → 目录"这个方向不联动。
      const categoryScoped = activeCategory === ''
        ? allSkills
        : allSkills.filter((skill) => {
          const list = skillCategories(skill)
          return activeCategory === UNCATEGORIZED ? list.length === 0 : list.includes(activeCategory)
        })
      const scopedCounts = new Map()
      for (const skill of categoryScoped) {
        scopedCounts.set(skill.rootId, (scopedCounts.get(skill.rootId) || 0) + 1)
      }
      const scopedRootIds = new Set(categoryScoped.map((skill) => skill.rootId))
      const rootLabel = rootLabeler([...(catalog.roots || []), { id: 'plugin', label: t('statusProvider') }])
      const opened = skills.find((skill) => `${skill.rootId}/${skill.name}` === openName)
      const counts = new Map()
      for (const skill of allSkills) counts.set(skill.rootId, (counts.get(skill.rootId) || 0) + 1)
      // 随包分发的根可能有好几个、`label` 全是 `bundled`：只写标签的话下拉里会出现
      // 两个一模一样的「bundled（0）」，根本分不清选哪个。重名时补上路径尾部。
      const rootOptionText = (() => {
        const list = catalog.roots || []
        const seen = new Map()
        for (const root of list) {
          const base = root.label || root.id
          seen.set(base, (seen.get(base) || 0) + 1)
        }
        return new Map(list.map((root) => {
          const base = root.label || root.id
          const tail = (seen.get(base) || 0) > 1
            ? ` · ${String(root.path || '').split(/[\\/]+/).filter(Boolean).slice(-2).join('/') || root.id}`
            : ''
          // 选了分类时，条数按"分类筛完之后"的数算，跟下拉里剩下的目录对得上。
          const countOf = (activeCategory === '' ? counts : scopedCounts).get(root.id) || 0
          return [root.id, `${base}${tail}（${countOf}）`]
        }))
      })()

      React.useEffect(() => { setFile(undefined) }, [openName])

      const openDetail = (skill) => {
        const key = `${skill.rootId}/${skill.name}`
        setOpenName(openName === key ? '' : key)
      }
      const readFile = async (skill) => {
        setOpenName(`${skill.rootId}/${skill.name}`)
        try {
          const result = await call(`${ROUTE.read}?cwd=${encodeURIComponent(props.cwd)}&rootId=${encodeURIComponent(skill.rootId)}&name=${encodeURIComponent(skill.name)}`)
          setFile(result.ok ? result.text : String(result.error || ''))
        } catch (error) {
          setFile(String(error.message || error))
        }
      }

      return h(React.Fragment, null,
        // 已安装页自己的工具栏（页签专属控件都放这里，不去动右上角那组按钮）。
        // 两个筛选器各有自己的 .5px 边框（DSH 搜索框那种字段框），一眼能看出是两个，
        // 展开后的浮层也用 DSH 的菜单样式。
        h('div', { style: styles.toolbar, 'data-sm-toolbar': '1' },
          h(FilterSelect, {
            name: 'root',
            label: t('rootFilter'),
            value: props.rootFilter,
            onChange: props.onFilter,
            // 选了分类时只列有这个分类的目录（反向联动），条数也用筛选后的数。
            options: [
              { value: '', label: `${t('allRoots')}（${categoryScoped.length}）` },
              ...(providerSkills.length && scopedRootIds.has('plugin')
                ? [{ value: 'plugin', label: `${t('statusProvider')}（${(activeCategory === '' ? counts : scopedCounts).get('plugin') || 0}）` }]
                : []),
              ...(catalog.roots || [])
                .filter((root) => activeCategory === '' || scopedRootIds.has(root.id))
                .map((root) => ({ value: root.id, label: rootOptionText.get(root.id) })),
            ],
          }),
          h(FilterSelect, {
            name: 'category',
            label: t('categoryFilter'),
            value: activeCategory,
            onChange: props.onCategoryFilter,
            disabled: categoryOptions.length === 0 && uncategorized === 0,
            options: [
              { value: '', label: `${t('allCategories')}（${rootSkills.length}）` },
              ...categoryOptions.map((name) => ({ value: name, label: `${name}（${categoryCounts.get(name) || 0}）` })),
              ...(uncategorized
                ? [{ value: UNCATEGORIZED, label: `${t('uncategorized')}（${uncategorized}）` }]
                : []),
            ],
          }),
          h('span', { style: styles.spacer }),
          h(Btn, { variant: 'primary', className: COMPACT_CLASS, onClick: () => props.onImport() }, t('importLocal'))),
        h('div', { style: styles.muted },
          [
            // 筛选时计数写成「筛出来的 / 全部」，否则永远只报总数，看不出筛没筛。
            props.rootFilter === '' && activeCategory === ''
              ? `${t('skillCount')} ${allSkills.length} ${t('unit')}`
              : `${t('skillCount')} ${skills.length} / ${allSkills.length} ${t('unit')}`,
            props.rootFilter === '' ? '' : rootLabel(props.rootFilter),
            activeCategory === ''
              ? ''
              : activeCategory === UNCATEGORIZED ? t('uncategorized') : activeCategory,
            catalog.scopeState === 'agent' ? '' : t('statusPredicted'),
          ].filter(Boolean).join(' · ')),
        opened
          ? h(SkillDetailDialog, {
            skill: opened,
            file,
            rootLabel,
            busy: props.busy,
            // 可选的技能目录（只列真实存在的根）与全目录用过的分类（下拉里给选）。
            roots: (catalog.roots || []).filter((root) => root.exists !== false),
            allCategories: [...new Set(allSkills.flatMap((skill) => skillCategories(skill)))].sort((left, right) => left.localeCompare(right)),
            onClose: () => setOpenName(''),
            onRead: readFile,
            onHide: () => setFile(undefined),
            // 只有点「确定」才落盘：先改分类（同目录内改文件），再搬目录，最后刷新注册表。
            onSave: async (skill, draft) => {
              await props.onSave(skill, draft)
              setOpenName('')
            },
          })
          : null,
        skills.length === 0
          ? h('div', { style: styles.muted }, props.rootFilter === '' ? t('empty') : t('emptyFiltered'))
          : h('div', { style: styles.grid },
            skills.map((skill) => h(SkillCard, {
              key: `${skill.rootId}/${skill.name}`,
              skill,
              rootLabel,
              busy: props.busy,
              open: openName === `${skill.rootId}/${skill.name}`,
              onOpen: openDetail,
              onToggle: props.onToggle,
              onRead: readFile,
              onTrash: (skill) => setPendingTrash(skill),
            }))),
        // 删除确认弹窗（DSH 卸载确认那套）：点了确认才真的删。
        pendingTrash
          ? h(ConfirmDialog, {
            title: t('confirmDeleteTitle'),
            description: t('confirmTrash'),
            confirmLabel: t('trash'),
            busy: props.busy,
            onCancel: () => setPendingTrash(undefined),
            onConfirm: () => {
              const target = pendingTrash
              setPendingTrash(undefined)
              props.onTrash(target)
            },
          })
          : null,
        (catalog.warnings || []).length
          ? h('div', { style: { ...styles.warn, marginTop: '8px' } }, `${t('warnings')}：${catalog.warnings.join('；')}`)
          : null)
    }

    /**
     * 市场页。
     * @param {object} props 属性。
     * @returns {any} 元素。
     */
    function MarketTab(props) {
      const catalog = props.catalog
      const [query, setQuery] = React.useState('')
      const [items, setItems] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      // 是否已经搜过：搜过一次之后，顶栏「刷新」就重跑那次搜索。
      const [searched, setSearched] = React.useState(false)
      // 待确认的安装：宿主要求"看得见的同意"——先看清单，再确认落盘。
      const [pendingInstall, setPendingInstall] = React.useState(undefined)
      const targetRootId = props.installTargetId
      const installed = new Map((catalog.installed || []).map((entry) => [entry.name, entry]))
      const rootLabel = rootLabeler(catalog.roots)
      const writableRoots = (catalog.roots || []).filter((root) => root.writable !== false)

      // 顶栏的「刷新」在这个页签下 = 重跑当前搜索（并顺带刷新已装列表，由页面负责）。
      const refreshSignal = props.refreshSignal
      React.useEffect(() => {
        if (!refreshSignal) return
        if (searched || query.trim()) void search()
      }, [refreshSignal])

      const search = async () => {
        setBusy(true)
        setMessage('')
        try {
          const result = await call(`${ROUTE.market}?q=${encodeURIComponent(query)}`)
          if (!result.ok) throw new Error(result.error || 'market error')
          setItems(result.items || [])
          setSearched(true)
          if (!result.items || result.items.length === 0) setMessage(t('emptyFiltered'))
        } catch (error) {
          setMessage(String(error.message || error))
        } finally {
          setBusy(false)
        }
      }
      /**
       * 安装：宿主是**两步**的 —— 第一次只回 manifest 清单（`needsConfirmation`），
       * 用户看过文件清单与摘要之后，带 `confirm: true` 再发一次才会真的落盘。
       * @param {object} item 市场条目。
       * @param {boolean} confirm 是否是确认后的第二次请求。
       * @returns {Promise<void>} 无。
       */
      const install = async (item, confirm) => {
        setBusy(true)
        setMessage('')
        try {
          const result = await call(ROUTE.install, {
            method: 'POST',
            body: { name: item.name, version: item.version, rootId: targetRootId, cwd: props.cwd, confirm: confirm === true },
          })
          if (result.needsConfirmation) {
            setPendingInstall({ item, manifest: result.manifest, target: result.target })
            return
          }
          if (!result.ok) throw new Error(result.error || 'install failed')
          setMessage(`${t('done')}：${item.name} → ${rootLabel(targetRootId)}`)
          setPendingInstall(undefined)
          props.onRefresh()
        } catch (error) {
          setMessage(String(error.message || error))
        } finally {
          setBusy(false)
        }
      }
      const uninstall = async (entry) => {
        setBusy(true)
        setMessage('')
        try {
          const result = await call(ROUTE.uninstall, { method: 'POST', body: { name: entry.name, cwd: props.cwd } })
          if (!result.ok) throw new Error(result.error || 'uninstall failed')
          setMessage(`${t('done')}：${entry.name}`)
          props.onRefresh()
        } catch (error) {
          setMessage(String(error.message || error))
        } finally {
          setBusy(false)
        }
      }

      if (catalog.marketConfigured !== true) {
        return h('div', { style: styles.list },
          h('div', { style: styles.topbar },
            h('input', {
              style: { ...styles.input, ...styles.grow },
              value: query,
              placeholder: t('marketSearch'),
              disabled: true,
              onChange: (event) => setQuery(event.target.value),
            }),
            h(Btn, { variant: 'outline', onClick: search, disabled: true }, t('searchGo')),
            // 设置属于市场（市场地址等），所以放在搜索右边。按钮层级跟 DSH 一致：
            // 搜索 = 描边（白底），设置 = 实心主按钮（黑底）。
            h(Btn, { variant: 'primary', onClick: () => props.onOpenSettings() }, t('settings'))),
          h('div', { style: styles.warn }, t('marketUnconfigured')),
          h('div', { style: styles.muted }, catalog.marketUrl ? `${t('marketUrl')}：${catalog.marketUrl}` : ''),
          (catalog.installed || []).length
            ? h('div', { style: styles.list }, (catalog.installed || []).map((entry) => h('div', { key: entry.name, style: styles.listItem },
              h('span', { style: styles.cardName }, entry.name),
              h(Badge, null, `${t('installedVersion')} ${entry.version}`),
              h('span', { style: styles.muted }, rootLabel(entry.rootId)),
              h('span', { style: styles.spacer }),
              h('button', { style: { ...styles.button, ...styles.buttonDanger }, onClick: () => uninstall(entry), disabled: busy }, t('uninstall')))))
            : null)
      }

      return h(React.Fragment, null,
        h('div', { style: styles.topbar },
          h('input', {
            style: { ...styles.input, ...styles.grow },
            value: query,
            placeholder: t('marketSearch'),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') search() },
          }),
          h(Btn, { variant: 'outline', onClick: search, disabled: busy }, t('searchGo')),
          // 设置属于市场（市场地址等），所以放在搜索右边。按钮层级跟 DSH 一致：
          // 搜索 = 描边（白底），设置 = 实心主按钮（黑底）。
          h(Btn, { variant: 'primary', onClick: () => props.onOpenSettings() }, t('settings')),
          h('span', { style: styles.spacer }),
          h(FilterSelect, {
            name: 'install-root',
            label: t('installedAt'),
            value: targetRootId,
            onChange: (value) => props.onInstallTarget(value),
            options: writableRoots.map((root) => ({ value: root.id, label: root.label || root.id })),
          })),
        h('div', { style: styles.muted }, t('marketHint')),
        message ? h('div', { style: styles.muted }, message) : null,
        h('div', { style: styles.list },
          items.map((item) => h('div', { key: item.name, style: styles.listItem },
            h('span', { style: styles.cardName }, item.name),
            h(Badge, null, item.version || ''),
            item.description ? h('span', { style: { ...styles.muted, flex: 1, minWidth: '160px' } }, item.description) : h('span', { style: styles.spacer }),
            installed.has(item.name) ? h(Badge, { tone: 'ok' }, t('installedVersion')) : null,
            h('button', { style: { ...styles.button, ...styles.buttonPrimary }, onClick: () => install(item, false), disabled: busy || !targetRootId }, busy ? t('installing') : t('install'))))),
        (catalog.installed || []).length
          ? h(React.Fragment, null,
            h('div', { style: styles.muted }, `${t('installedAt')}：`),
            h('div', { style: styles.list }, (catalog.installed || []).map((entry) => h('div', { key: entry.name, style: styles.listItem },
              h('span', { style: styles.cardName }, entry.name),
              h(Badge, null, entry.version),
              h('span', { style: { ...styles.muted, flex: 1, minWidth: '160px' } }, entry.path || ''),
              h('button', { style: { ...styles.button, ...styles.buttonDanger }, onClick: () => uninstall(entry), disabled: busy }, t('uninstall'))))))
          : null,
        // 安装确认弹窗：先把 manifest 的文件清单与摘要摊开，用户点头才落盘。
        pendingInstall
          ? (() => {
            const manifest = pendingInstall.manifest || {}
            const files = Array.isArray(manifest.files) ? manifest.files : []
            const body = [
              h('div', { key: 'target', style: styles.muted },
                `${t('installTarget')}：${(pendingInstall.target && pendingInstall.target.label) || ''}`),
              h(HoverBubble, {
                key: 'digest',
                tag: 'div',
                text: `${manifest.name}@${manifest.version} · ${t('bundleDigest')} ${(manifest.bundle && manifest.bundle.sha256) || '—'}`,
                tipKey: 'digest',
                probe: isEllipsized,
                style: styles.pickedPath,
              }),
              h('div', { key: 'files', style: styles.browseList }, files.map((file) => h('div', {
                key: file.path,
                style: styles.browseRow,
              },
                h('span', { style: styles.browseName }, file.path),
                h('span', { style: styles.muted }, `${file.size} B`)))),
            ]
            const footer = h('div', { style: styles.row },
              h(Btn, { variant: 'ghost', onClick: () => setPendingInstall(undefined) }, t('cancel')),
              h(Btn, { variant: 'primary', onClick: () => { void install(pendingInstall.item, true) } }, t('confirmInstall')))
            if (UI && UI.Modal) {
              return h(UI.Modal, {
                open: true,
                onClose: () => setPendingInstall(undefined),
                title: t('confirmInstallTitle'),
                closeLabel: t('close'),
                className: IMPORT_DIALOG_CLASS,
                footer,
              }, body)
            }
            return h('div', { key: 'confirm', style: { ...styles.overlay, zIndex: 1100 } },
              h('div', { style: styles.dialog },
                h('div', { style: styles.title }, t('confirmInstallTitle')),
                body,
                footer))
          })()
          : null)
    }

    /**
     * 回收站页：一行一条（DSH 插件列表那种「细线分隔的行」，不是一叠卡片）。
     *
     * 文字全部照 DSH 的行样式：名字 13.5/500、路径 mono 11.5、来源与时间 12.5 二级文字色；
     * 按钮三个：`清空回收站`（红）、`还原`（白）、`彻底删除`（红）。
     * 两个危险操作都走 DSH 的确认弹窗（描边「取消」+ 实心红确认），不再用 `window.confirm`。
     * @param {object} props 属性。
     * @returns {any} 元素。
     */
    function TrashTab(props) {
      const catalog = props.catalog
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      // 待确认的危险操作：`{ kind: 'all' }` 或 `{ kind: 'one', item }`。
      const [pending, setPending] = React.useState(undefined)
      const trash = catalog.trash || []
      const rootLabel = rootLabeler(catalog.roots)

      const run = async (body) => {
        setBusy(true)
        setMessage('')
        try {
          const result = await call(ROUTE.action, { method: 'POST', body: { ...body, cwd: props.cwd } })
          if (!result.ok) throw new Error(result.error || 'action failed')
          props.onRefresh()
        } catch (error) {
          setMessage(String(error.message || error))
        } finally {
          setBusy(false)
        }
      }

      /** 把 ISO 时间显示成本地时间；解析不了就原样显示。 */
      const when = (at) => {
        if (!at) return ''
        const date = new Date(at)
        return Number.isNaN(date.getTime()) ? String(at) : date.toLocaleString()
      }

      return h(React.Fragment, null,
        h('div', { style: styles.topbar },
          h('span', { style: styles.muted }, `${t('skillCount')} ${trash.length} ${t('unit')}`),
          h('span', { style: styles.spacer }),
          trash.length
            ? h(Btn, {
              variant: 'outline',
              className: `${COMPACT_CLASS} ${DANGER_CLASS}`,
              icon: h(TrashIcon, { size: 14 }),
              onClick: () => setPending({ kind: 'all' }),
              disabled: busy,
            }, t('purgeAll'))
            : null),
        message ? h('div', { style: styles.error }, message) : null,
        trash.length === 0
          ? h('div', { style: styles.muted }, t('trashEmpty'))
          : h('ul', { style: styles.trashList }, trash.map((item) => h('li', { key: item.id, style: styles.trashRow, 'data-trash-row': item.name },
            h('div', { style: styles.trashMain },
              h('div', { style: styles.trashName }, item.name),
              h('div', { style: styles.trashMeta },
                h('span', { style: styles.trashBadge }, rootLabel(item.rootId)),
                h('span', null, when(item.at)))),
            h('div', { style: styles.trashActions },
              h(Btn, {
                variant: 'outline',
                className: COMPACT_CLASS,
                onClick: () => void run({ action: 'restore', id: item.id }),
                disabled: busy,
              }, t('restore')),
              h(Btn, {
                variant: 'outline',
                className: `${COMPACT_CLASS} ${DANGER_CLASS}`,
                icon: h(TrashIcon, { size: 14 }),
                onClick: () => setPending({ kind: 'one', item }),
                disabled: busy,
              }, t('purge')))))),
        // 危险操作确认框：跟「删除技能」「卸载插件」同一套（描边取消 + 实心红确认）。
        pending
          ? h(ConfirmDialog, {
            title: pending.kind === 'all' ? t('purgeAllTitle') : t('purgeTitle'),
            description: pending.kind === 'all'
              ? `${t('purgeAllAsk')}（${trash.length} ${t('unit')}）`
              : `${pending.item.name}：${t('confirmPurge')}`,
            confirmLabel: pending.kind === 'all' ? t('purgeAll') : t('purge'),
            busy,
            onCancel: () => setPending(undefined),
            onConfirm: () => {
              const target = pending
              setPending(undefined)
              void run(target.kind === 'all'
                ? { action: 'purge', confirm: true }
                : { action: 'purge', id: target.item.id, confirm: true })
            },
          })
          : null)
    }

    /**
     * 设置页（这一版只读：改配置请编辑 profile 的 cordis.patch.yml）。
     * @param {object} props 属性。
     * @returns {any} 元素。
     */
    function SettingsTab(props) {
      const catalog = props.catalog
      return h('div', { style: styles.list },
        h('div', { style: styles.warn }, t('settingsReadonly')),
        h('div', { style: styles.detail },
          h('div', { style: styles.kv },
            h('div', { style: styles.muted }, t('marketUrl')),
            h('div', null, catalog.marketUrl || t('unconfigured')),
            h('div', { style: styles.muted }, t('cwd')),
            h('div', null, catalog.cwd || '-'),
            h('div', { style: styles.muted }, t('homes')),
            h('div', null, `DSH_HOME ${catalog.homes ? catalog.homes.dshHome : '-'}；agents ${catalog.homes ? catalog.homes.agentsHome : '-'}`),
            h('div', { style: styles.muted }, t('registry')),
            h('div', null, `${t('registryAt')} ${catalog.generatedAt || '-'} · revision ${catalog.revision || 0}`),
            h('div', { style: styles.muted }, `${t('hostBuild')} / ${t('clientBuild')}`),
            h('div', null, `${catalog.build || '（未知）'} / ${CLIENT_BUILD}`))),
        h('div', { style: styles.row },
          h('span', { style: styles.muted }, t('cwd')),
          h('input', {
            style: { ...styles.input, ...styles.grow, fontFamily: MONO, fontSize: '12px' },
            value: props.cwdDraft,
            placeholder: catalog.cwd || '',
            onChange: (event) => props.onCwdDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') props.onCwdCommit() },
          }),
          h('button', { style: styles.button, onClick: props.onCwdCommit }, t('done'))),
        h('div', { style: styles.muted }, t('cwdHint')),
        h('div', { style: styles.row },
          h(FilterSelect, {
            name: 'settings-import-root',
            label: t('chooseImportRoot'),
            value: props.importRootId,
            onChange: (value) => props.onImportRoot(value),
            options: (catalog.roots || [])
              .filter((root) => root.writable !== false)
              .map((root) => ({ value: root.id, label: root.label || root.id })),
          }),
          h('span', { style: styles.muted }, t('importRootHint'))),
        h('div', { style: styles.muted }, t('rootsTitle')),
        h('div', { style: styles.list }, (catalog.roots || []).map((root) => h('div', { key: root.id, style: styles.listItem },
          h('span', { style: styles.cardName }, root.label || root.id),
          h(Badge, null, `rank ${root.rank}`),
          root.writable === false ? h(Badge, { tone: 'warn' }, t('readonlyRoot')) : null,
          !root.exists ? h(Badge, { tone: 'danger' }, t('missingRoot')) : null,
          h('span', { style: { ...styles.muted, flex: 1, minWidth: '160px', wordBreak: 'break-all' } }, root.path)))))
    }

    /**
     * 设置弹窗（从技能市场页打开：市场地址、技能目录、导入目标、工作目录）。
     *
     * @param {object} props 属性。
     * @returns {any} 元素。
     */
    function SettingsDialog(props) {
      if (UI && UI.Modal) {
        return h(UI.Modal, {
          open: true,
          onClose: props.onClose,
          title: t('settingsTitle'),
          closeLabel: t('close'),
          className: IMPORT_DIALOG_CLASS,
        }, h(SettingsTab, props))
      }
      return h('div', { style: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget) props.onClose() } },
        h('div', { style: styles.dialog },
          h('div', { style: styles.row },
            h('div', { style: styles.title }, t('settingsTitle')),
            h('span', { style: styles.spacer }),
            h(CloseButton, { onClick: props.onClose })),
          h(SettingsTab, props)))
    }

    /**
     * 整页。
     * @param {{pickDirectory?: Function}} props 属性（`pickDirectory` 来自 `uiWorkspace`）。
     * @returns {any} 元素。
     */
    function SkillManagerPage(props) {
      const [tab, setTab] = React.useState('installed')
      const [catalog, setCatalog] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [rootFilter, setRootFilter] = React.useState('')
      // 第二个筛选项：技能的 `metadata.category`（和技能目录是"与"的关系）。
      const [categoryFilter, setCategoryFilter] = React.useState('')
      const [cwd, setCwd] = React.useState(() => {
        try { return window.localStorage.getItem(CWD_KEY) || '' } catch { return '' }
      })
      const [cwdDraft, setCwdDraft] = React.useState(cwd)
      const [importOpen, setImportOpen] = React.useState(false)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      // 市场页的"刷新"信号：市场页自己监听它去重跑当前搜索。
      const [marketRefresh, setMarketRefresh] = React.useState(0)
      const [importTargetId, setImportTargetId] = React.useState(() => {
        try { return window.localStorage.getItem(IMPORT_ROOT_KEY) || '' } catch { return '' }
      })

      const load = React.useCallback(async (refresh) => {
        setBusy(true)
        setError('')
        try {
          const query = `${refresh ? '?refresh=1' : '?'}${cwd ? `cwd=${encodeURIComponent(cwd)}` : ''}`
          const result = await call(`${ROUTE.catalog}${query}`)
          if (!result.ok) throw new Error(result.error || 'catalog failed')
          setCatalog(result)
        } catch (failure) {
          setError(String(failure.message || failure))
        } finally {
          setBusy(false)
        }
      }, [cwd])

      React.useEffect(() => { load(false) }, [load])

      // 选过的技能目录可能在下次刷新后没了（配置改了、根被移除、插件内嵌技能没了）：
      // 这时把筛选项清掉，否则会一直卡在"这个目录下没有技能"。
      React.useEffect(() => {
        if (!catalog || !rootFilter) return
        const known = (catalog.roots || []).some((root) => root.id === rootFilter)
          || (rootFilter === 'plugin' && (catalog.providerOnly || []).length > 0)
        if (!known) setRootFilter('')
      }, [catalog, rootFilter])

      const act = async (body, confirmText) => {
        if (confirmText && !window.confirm(confirmText)) return
        setBusy(true)
        setNotice('')
        try {
          const result = await call(ROUTE.action, { method: 'POST', body: { ...body, cwd } })
          if (!result.ok) throw new Error(result.error || 'action failed')
          setNotice(`${t('done')}：${result.name || body.name || ''}`)
          await load(true)
        } catch (failure) {
          setError(`${t('actionFailed')}：${String(failure.message || failure)}`)
        } finally {
          setBusy(false)
        }
      }

      const commitCwd = () => {
        const next = cwdDraft.trim()
        setCwd(next)
        try { window.localStorage.setItem(CWD_KEY, next) } catch { /* 隐私模式 */ }
      }

      /**
       * 刷新**当前页签**的内容：
       *   - 已安装：重扫技能目录（`refresh=1`，重建注册表）；
       *   - 技能市场：重跑当前搜索 + 刷新已装列表；
       *   - 回收站：重读目录数据（回收站台账就在里面）。
       * @returns {void}
       */
      const refreshCurrent = () => {
        if (tab === 'market') {
          setMarketRefresh((count) => count + 1)
          void load(false)
          return
        }
        void load(tab === 'installed')
      }

      if (!catalog) {
        return h('div', { style: styles.page },
          h('div', { style: styles.topbar }, h('div', { style: styles.title }, t('title'))),
          h('div', { style: styles.muted }, error || t('loading')))
      }

      const roots = catalog.roots || []
      const writableRoots = roots.filter((root) => root.writable !== false)
      /** 导入目标：记住上次用的；没记过就优先用户级根（项目级根更像"临时放一下"）。 */
      const preferredImportRoot = () => {
        if (importTargetId && writableRoots.some((root) => root.id === importTargetId)) return importTargetId
        const userLevel = writableRoots.find((root) => root.id === 'user-dsh' || root.id === 'user-agents')
        return (userLevel || writableRoots[0] || {}).id || ''
      }
      const defaultImportRootId = preferredImportRoot()
      const importRootLabel = (roots.find((root) => root.id === defaultImportRootId) || {}).label || defaultImportRootId
      const rememberImportRoot = (rootId) => {
        setImportTargetId(rootId)
        try { window.localStorage.setItem(IMPORT_ROOT_KEY, rootId) } catch { /* 隐私模式 */ }
      }
      const providerCount = (catalog.providerOnly || []).length
      const counts = new Map()
      for (const skill of catalog.skills || []) counts.set(skill.rootId, (counts.get(skill.rootId) || 0) + 1)
      const tabs = [
        ['installed', t('tabInstalled')],
        ['market', t('tabMarket')],
        ['trash', t('tabTrash')],
      ]
      /** 顶栏里的一个页签：普通文字按钮 + 选中底色（保持原来的样子，不换胶囊样式）。 */
      const tabButton = ([id, label]) => h('button', {
        key: id,
        type: 'button',
        style: { ...styles.tab, ...(tab === id ? styles.tabActive : {}) },
        onClick: () => setTab(id),
      }, label)

      return h('div', { style: styles.page },
        // 顶栏**固定不变**：标题 + 三个页签在左，右侧只有 `刷新`（全页唯一一个，位置固定）。
        // `刷新` 刷新的是**当前页签**的内容；`设置` 属于技能市场，放在市场页搜索框右边。
        h('div', { style: { ...styles.topbar, flexWrap: 'nowrap' }, 'data-sm-topbar': '1' },
          h('div', { style: styles.title }, t('title')),
          h('div', { style: styles.tabRow }, tabs.map(tabButton)),
          h('span', { style: styles.spacer }),
          h(Btn, {
            variant: 'outline',
            icon: h(RefreshIcon, null),
            onClick: refreshCurrent,
            disabled: busy,
            title: t('refresh'),
          }, busy ? t('refreshing') : t('refresh'))),
        error ? h('div', { style: styles.error }, error) : null,
        notice ? h('div', { style: styles.muted }, notice) : null,
        // 两边构建标记不一致 = 宿主半边没重启（HMR 只换客户端）。直接说清楚，
        // 否则用户只会看到"某个动作报了个奇怪的错"。**缺失也算不一致**：
        // 斜杠源没注册上时直接说出来（桌面端不方便开控制台）。
        props.slashWarning
          ? h('div', { style: styles.warn, 'data-sm-slash-warning': props.slashWarning },
            `${t('slashWarn')} ${props.slashWarning}`)
          : null,
        // 旧宿主根本不返回这个字段，那正是最需要提示的情况。
        catalog.build !== CLIENT_BUILD
          ? h('div', { style: styles.warn },
            `${t('buildMismatch')}：${t('clientBuild')} ${CLIENT_BUILD} / ${t('hostBuild')} ${catalog.build || '（未知）'} —— ${t('buildMismatchHint')}`)
          : null,
        h('div', { style: styles.main },
          h('div', { style: styles.body },
            tab === 'installed'
              ? h(InstalledTab, {
                catalog,
                cwd,
                busy,
                rootFilter,
                onFilter: setRootFilter,
                categoryFilter,
                onCategoryFilter: setCategoryFilter,
                onRefresh: () => load(true),
                onImport: () => setImportOpen(true),
                // 卡片/详情上的那一个开关：开 = 两个调用标记都不写，关 = 两个都写。
                // **必须一条请求把两个标记一起发**：宿主把缺省的标记当成 `true`
                // （`body.modelInvocable !== false`），分两次发会把另一个又打开——
                // 关掉时最终会变成"模型开、用户关"，等于没关。
                onToggle: async (skill, enabled) => {
                  setBusy(true)
                  setNotice('')
                  try {
                    const result = await call(ROUTE.action, {
                      method: 'POST',
                      body: {
                        action: 'set-invocation',
                        rootId: skill.rootId,
                        name: skill.name,
                        cwd,
                        modelInvocable: enabled,
                        userInvocable: enabled,
                      },
                    })
                    if (!result.ok) throw new Error(result.error || 'set-invocation failed')
                    setNotice(`${t(enabled ? 'switchOnDone' : 'switchOffDone')}：${skill.name}`)
                    await load(true)
                  } catch (failure) {
                    setError(`${t('actionFailed')}：${String(failure.message || failure)}`)
                  } finally {
                    setBusy(false)
                  }
                },
                // 删除：确认框已经在已安装页里问过了，这里直接删（不再弹 window.confirm）。
                onTrash: (skill) => act({ action: 'trash', rootId: skill.rootId, name: skill.name }),
                // 详情页「确定」：分类优先（同目录内改文件），再搬目录；两步都成功才刷新注册表。
                // 注意搬完目录后技能已经在新根里，所以第二步（如果有）要用**目标**根。
                onSave: async (skill, draft) => {
                  setBusy(true)
                  setError('')
                  setNotice('')
                  let rootForWrite = skill.rootId
                  try {
                    const before = skillCategories(skill)
                    if (!sameCategories(draft.categories, before)) {
                      const result = await call(ROUTE.action, {
                        method: 'POST',
                        body: {
                          action: 'set-categories',
                          rootId: rootForWrite,
                          name: skill.name,
                          categories: draft.categories,
                          cwd,
                        },
                      })
                      if (!result.ok) throw new Error(result.error || 'set-categories failed')
                    }
                    if (draft.rootId !== skill.rootId) {
                      const result = await call(ROUTE.action, {
                        method: 'POST',
                        body: {
                          action: 'move-root',
                          rootId: rootForWrite,
                          name: skill.name,
                          targetRootId: draft.rootId,
                          cwd,
                        },
                      })
                      if (!result.ok) throw new Error(result.error || 'move-root failed')
                      rootForWrite = draft.rootId
                    }
                    setNotice(`${t('saveDone')}：${skill.name}`)
                    // 重建注册表（等同点一次「刷新」），否则 / 菜单与下拉还会读到旧扫描结果。
                    await load(true)
                  } catch (failure) {
                    setError(`${t('actionFailed')}：${String(failure.message || failure)}`)
                  } finally {
                    setBusy(false)
                  }
                },
              })
              : tab === 'market'
                ? h(MarketTab, {
                  catalog,
                  cwd,
                  installTargetId: defaultImportRootId,
                  onInstallTarget: setImportTargetId,
                  onRefresh: () => load(true),
                  refreshSignal: marketRefresh,
                  onOpenSettings: () => setSettingsOpen(true),
                })
                : h(TrashTab, { catalog, cwd, onRefresh: () => load(false) })),
          settingsOpen
            ? h(SettingsDialog, {
              catalog,
              cwdDraft,
              importRootId: defaultImportRootId,
              onCwdDraft: setCwdDraft,
              onImportRoot: rememberImportRoot,
              onCwdCommit: () => { commitCwd(); load(true) },
              onClose: () => setSettingsOpen(false),
            })
            : null,
          importOpen
            ? h(ImportDialog, {
              cwd,
              rootId: defaultImportRootId,
              rootLabel: importRootLabel,
              roots: writableRoots,
              onRootChange: rememberImportRoot,
              pickDirectory: props.pickDirectory,
              hasPicker: props.hasPicker,
              onClose: () => setImportOpen(false),
              onDone: () => load(true),
            })
            : null))
    }

    /**
     * 渲染兜底：任何渲染异常都不该把整个侧栏弄白。
     */
    class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failure: '' }
      }

      static getDerivedStateFromError(error) {
        return { failure: String((error && error.message) || error) }
      }

      render() {
        if (this.state.failure) {
          return h('div', { style: { padding: '16px' } },
            h('div', { style: styles.title }, t('title')),
            h('div', { style: styles.error }, `面板渲染失败：${this.state.failure}`),
            h('div', { style: styles.muted }, 'Host 侧路由不受影响；请把这行文字发给开发者。'))
        }
        return this.props.children
      }
    }

    /**
     * 侧栏图标。
     * @returns {any} 元素。
     */
    function SidebarIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3 2.5h10a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Zm0 6h10a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('path', { d: 'M4.5 4.5h3m-3 6h3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const bound = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : undefined
        t = (key) => {
          // 只在 locale 服务**真的**给出译文时采用它：有些实现会把未知键原样回显，
          // 那时必须回退到自带字典，否则界面会显示 `title`、`tabInstalled` 这种键名。
          const localized = bound ? bound(key) : undefined
          if (typeof localized === 'string' && localized !== '' && localized !== key) return localized
          return zh[key] || en[key] || key
        }
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skill-manager: dictionaries')

        // 详情弹窗要宽：DSH 的 Modal 宽度来自它自己的样式表，我们拿不到也改不动，
        // 就注入一段**只作用于我们那个类名**的 CSS（`!important` 覆盖它的 width/max-width）。
        ctx.effect(() => {
          if (typeof document === 'undefined' || !document.head) return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-skill-manager', 'dialog-width')
          style.textContent = DIALOG_CSS
          document.head.appendChild(style)
          return () => {
            try {
              style.remove()
            } catch {
              /* 已经不在文档里 */
            }
          }
        }, 'skill-manager: dialog width')

        // DSH 自己的"选目录"，两条来源按可靠性排：
        //   1. 桌面端 preload 桥 `globalThis.__DSH_DIRECTORY_PICKER__`（最直接）；
        //   2. 客户端服务 `ctx.uiWorkspace.pickDirectory()`。
        // **必须在点击时才解析**：客户端插件按加载顺序 apply，我的插件可能先于
        // ui-workspace 就绪，apply 时抓到 undefined 会让"选目录"永远不可用（踩过一次）。
        const resolvePicker = () => {
          const bridge = typeof globalThis !== 'undefined' ? globalThis.__DSH_DIRECTORY_PICKER__ : undefined
          if (bridge && typeof bridge.pick === 'function') return () => bridge.pick()
          const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
          if (workspace && typeof workspace.pickDirectory === 'function') return () => workspace.pickDirectory()
          return undefined
        }
        const hasPicker = () => typeof resolvePicker() === 'function'
        const pickDirectory = async () => {
          const pick = resolvePicker()
          if (!pick) {
            const error = new Error('no directory picker')
            error.code = 'PICKER_UNAVAILABLE'
            throw error
          }
          return pick()
        }

        // 斜杠源的注册结果放在这里：桌面端不一定方便开控制台，面板里直接给一行诊断。
        const slashState = { status: '' }
        /**
         * 面板里显示斜杠源的诊断（正常情况永远不显示）。
         * 等 2.5 秒再判定，避免"服务稍晚就绪"时闪一下。
         * @returns {string} 诊断文字；空字符串表示没问题。
         */
        const useSlashWarning = () => {
          const [warning, setWarning] = React.useState('')
          React.useEffect(() => {
            const timer = setTimeout(() => {
              setWarning(slashState.status === '' || slashState.status === 'ok' ? '' : slashState.status)
            }, 2500)
            return () => clearTimeout(timer)
          }, [])
          return warning
        }
        const Panel = () => h(Guard, null, h(SkillManagerPage, {
          pickDirectory,
          hasPicker,
          slashWarning: useSlashWarning(),
        }))
        ctx.effect(() => ctx.slots.inject('main', function* registerMain() {
          yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel)
        }), 'skill-manager: main panel')

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 12,
          label: () => t('panel'),
          locale: NS,
        }, SidebarIcon)), 'skill-manager: sidebar entry')

        // `/` 菜单源：两级提示 `/skill/` → 技能目录 → `/skill/<目录>/` → 技能。
        // 选中后插入 `/skill/<目录>/<技能>`，由 Host 侧的 pre-step 手势注入技能内容。
        // 名字必须与内置的 `skill` 源不同——(trigger, name) 重复会直接注册失败。
        // **不要在 apply 时只 get 一次**：客户端插件按加载顺序 apply，`inputTriggers`
        // 完全可能比本插件晚就绪；抓不到就永远不注册，而且没有任何报错——
        // 表现就是"/ 菜单里连 /skill/ 都没有"（和当年 uiWorkspace 那个坑同一类）。
        // 所以这里拿不到就轮询等一等，拿到再注册；一直等不到才打一条明确的告警。
        let slashRegistered = false
        let slashTimer
        let slashRetried = false
        const slashStopped = () => {
          if (slashTimer !== undefined) {
            clearInterval(slashTimer)
            slashTimer = undefined
          }
        }
        ctx.effect(() => () => slashStopped(), 'skill-manager: slash poll cleanup')
        const registerSlashSource = (inputTriggers) => {
          let cache = { at: 0, data: undefined }
          /**
           * 取目录视图数据（10 秒缓存；失败静默退回空列表，不打扰输入）。
           * @returns {Promise<object>} 目录数据。
           */
          const loadData = async () => {
            if (cache.data && Date.now() - cache.at < 10_000) return cache.data
            try {
              const result = await call(ROUTE.catalog)
              cache = { at: Date.now(), data: result.ok === false ? undefined : result }
            } catch {
              cache = { at: Date.now(), data: undefined }
            }
            return cache.data
          }
          return inputTriggers.registerSource({
            trigger: '/',
            name: 'skill-path',
            order: 20,
            async candidates(session, request) {
              const data = await loadData()
              if (!data) return []
              const query = String((request && request.query) || '')
              const lower = query.toLowerCase()
              const skills = (data.skills || []).filter((skill) => skill.valid !== false && skill.invocation?.userInvocable !== false)
              const roots = (data.roots || []).filter((root) => root.exists !== false)
              const labelOf = rootLabeler(data.roots)

              if (!lower.startsWith('skill')) {
                return [{ name: 'skill', label: '/skill/', description: '按技能目录调用技能' }].filter((item) => lower === '' || 'skill'.includes(lower))
              }
              const rest = query.slice('skill'.length).replace(/^\//, '')
              const slash = rest.indexOf('/')
              if (slash === -1) {
                // `/skill` 或 `/skill/<目录前缀>`：提示下一级——技能目录。
                return roots
                  .filter((root) => rest === '' || String(root.id).toLowerCase().startsWith(rest.toLowerCase()) || String(root.label || '').toLowerCase().startsWith(rest.toLowerCase()))
                  .slice(0, 20)
                  .map((root) => ({ name: `${root.id}/`, label: `${root.id}/`, insert: `skill/${root.id}/`, description: labelOf(root.id) }))
              }
              const rootId = rest.slice(0, slash)
              const prefix = rest.slice(slash + 1).toLowerCase()
              return skills
                .filter((skill) => skill.rootId === rootId)
                .filter((skill) => prefix === '' || String(skill.name).toLowerCase().includes(prefix))
                .slice(0, 30)
                .map((skill) => ({
                  name: skill.name,
                  label: skill.name,
                  insert: `skill/${rootId}/${skill.name} `,
                  description: skill.description || '',
                }))
            },
            onPick(pick) {
              const candidate = pick && pick.candidate
              if (!candidate) return { text: undefined }
              const insert = candidate.insert || (candidate.name === 'skill' ? 'skill/' : candidate.name)
              return { text: `/${insert}` }
            },
          })
        }
        /**
         * 试着注册一次；服务还没就绪就等下一轮。
         * @returns {boolean} 是否已经处理完（注册成功或明确失败）。
         */
        const tryRegisterSlash = () => {
          if (slashRegistered) return true
          const inputTriggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined
          if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return false
          try {
            const dispose = registerSlashSource(inputTriggers)
            slashRegistered = true
            slashState.status = 'ok'
            slashStopped()
            // 轮询补注册成功时留一条日志：这条链路出问题时，日志里能直接看出是不是"服务晚到"。
            if (slashRetried) console.info('[skill-manager] inputTriggers 晚就绪，已补注册 /skill 提示源')
            if (typeof dispose === 'function') ctx.effect(() => dispose, 'skill-manager: slash source dispose')
            return true
          } catch (error) {
            // 注册本身失败（例如名字冲突）：别反复重试，但要说出来。
            slashRegistered = true
            slashStopped()
            slashState.status = `注册失败：${String((error && error.message) || error)}`
            console.warn('[skill-manager] /skill 提示源注册失败：', error)
            return true
          }
        }
        if (!tryRegisterSlash()) {
          slashRetried = true
          slashTimer = setInterval(() => { tryRegisterSlash() }, 400)
          setTimeout(() => {
            if (slashRegistered) return
            slashStopped()
            slashState.status = '等不到 inputTriggers 服务'
            console.warn('[skill-manager] 等不到 inputTriggers 服务，/skill 提示不可用')
          }, 20_000)
        }
      },
    }
  },
})
