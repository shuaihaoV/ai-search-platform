/**
 * 应用根组件：URL 状态、搜索生命周期、设置、主题、抓取抽屉。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ApiError,
  AbortedError,
  clearAuthToken,
  getAuthToken,
  getConfig,
  isUnauthorizedError,
  login as loginApi,
  search as searchApi,
  fetchUrl,
  setAuthToken,
} from './api/client';
import {
  normalizeSettings,
  defaultsFromConfig,
  DEFAULT_SETTINGS,
  clearSettings,
  loadSettings,
  saveSettings,
} from './lib/settings';
import {
  FALLBACK_CONFIG,
  FALLBACK_LIMITS,
  countChars,
  validateCount,
  validateFetchUrl,
  validateLocalization,
  validateOriQuestion,
  validateQuery,
} from './lib/validation';
import {
  buildShareUrl,
  pushLandingState,
  pushSearchState,
  readUrlState,
} from './lib/urlState';
import {
  THEME_LABELS,
  applyTheme,
  loadTheme,
  nextThemeMode,
  saveTheme,
  watchSystemTheme,
} from './lib/theme';
import { SearchForm } from './components/SearchForm';
import { AdvancedSettings } from './components/AdvancedSettings';
import { SyntaxHelp, appendSyntaxExample } from './components/SyntaxHelp';
import { Modal } from './components/Modal';
import { PasswordGate } from './components/PasswordGate';
import { ResultList } from './components/ResultList';
import { FetchDrawer } from './components/FetchDrawer';
import type { FetchTarget } from './components/FetchDrawer';
import { ErrorBanner } from './components/ErrorBanner';
import { EmptyState } from './components/EmptyState';
import { Skeleton } from './components/Skeleton';
import { useToast } from './components/Toast';
import { copyText } from './components/CopyButton';
import {
  AutoThemeIcon,
  HomeIcon,
  InfoIcon,
  MoonIcon,
  SunIcon,
  WarningIcon,
} from './components/Icons';
import type {
  AppConfig,
  FetchEnvelope,
  NormalizedResult,
  RequestEcho,
  SearchEnvelope,
  SearchSettings,
  ThemeMode,
} from './types';

/** 首页示例关键词（仅在输入框为空时展示） */
const LANDING_EXAMPLES: readonly string[] = [
  '大模型 推理 优化',
  'site:openai.com 定价',
  '"向量数据库 选型" -广告',
  'lang:zh AI 搜索 产品',
];

type SearchStatus = 'idle' | 'loading' | 'success' | 'error';

interface SearchState {
  status: SearchStatus;
  query: string;
  echo: RequestEcho | null;
  envelope: SearchEnvelope | null;
  error: ApiError | null;
}

interface FetchState {
  open: boolean;
  target: FetchTarget | null;
  force: boolean;
  status: 'idle' | 'loading' | 'success' | 'error';
  envelope: FetchEnvelope | null;
  error: ApiError | null;
}

const INITIAL_SEARCH_STATE: SearchState = {
  status: 'idle',
  query: '',
  echo: null,
  envelope: null,
  error: null,
};

const INITIAL_FETCH_STATE: FetchState = {
  open: false,
  target: null,
  force: false,
  status: 'idle',
  envelope: null,
  error: null,
};

interface InvalidUrlNotice {
  raw: string | null;
  reason: string;
}

export default function App(): ReactElement {
  const { notify, view: toastView } = useToast();

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  // 访问密码门禁：null = 未知（配置未就绪），true = 需要密码
  const [authRequired, setAuthRequired] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  // /api/config 是否已落定（成功或失败）：首屏自动搜索需等它，确保默认值优先来自接口
  const [configSettled, setConfigSettled] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadTheme());

  const [query, setQuery] = useState('');
  // 首次渲染：优先恢复上次保存的偏好；无保存值时用内置默认（need_content=true）
  const savedSettingsRef = useRef<SearchSettings | null>(null);
  const [settings, setSettings] = useState<SearchSettings>(() => {
    const saved = loadSettings(FALLBACK_LIMITS);
    savedSettingsRef.current = saved;
    return saved ?? DEFAULT_SETTINGS;
  });
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [syntaxModalOpen, setSyntaxModalOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [invalidUrl, setInvalidUrl] = useState<InvalidUrlNotice | null>(null);

  const [searchState, setSearchState] = useState<SearchState>(INITIAL_SEARCH_STATE);
  const [fetchState, setFetchState] = useState<FetchState>(INITIAL_FETCH_STATE);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const lastFetchTriggerRef = useRef<HTMLElement | null>(null);
  const bootstrappedRef = useRef(false);
  const configRef = useRef<AppConfig | null>(null);

  const limits = useMemo(() => config?.limits ?? FALLBACK_LIMITS, [config]);

  // 供 config 回调读取最新搜索状态，避免闭包陷阱
  const searchStateRef = useRef<SearchState>(INITIAL_SEARCH_STATE);
  useEffect(() => {
    searchStateRef.current = searchState;
  }, [searchState]);

  // 主题：应用 + 持久化
  useEffect(() => {
    applyTheme(themeMode);
    saveTheme(themeMode);
  }, [themeMode]);

  // auto 模式监听系统配色变化
  useEffect(() => {
    if (themeMode !== 'auto') {
      return undefined;
    }
    const handle = watchSystemTheme(() => {
      applyTheme('auto');
    });
    return () => {
      handle.dispose();
    };
  }, [themeMode]);

  // 读取 /api/config；失败时使用内置兜底
  useEffect(() => {
    const controller = new AbortController();
    void (async (): Promise<void> => {
      try {
        const loaded = await getConfig({ signal: controller.signal });
        if (controller.signal.aborted) {
          return;
        }
        setConfig(loaded);
        configRef.current = loaded;
        // 门禁开启且本地没有 token 时，先要求输入密码
        if (loaded.auth.enabled) {
          setAuthRequired(getAuthToken() === null);
        } else {
          setAuthRequired(false);
        }
        setSettings((prev) => {
          // 首选 /api/config 的 defaults；若用户曾保存过偏好，则在默认值之上叠加偏好
          const defaults = defaultsFromConfig(loaded);
          const saved = savedSettingsRef.current;
          if (saved !== null) {
            return {
              ...defaults,
              count: clampSettingCount(saved.count, loaded),
              need_content: saved.need_content,
              ori_question: [...saved.ori_question]
                .slice(0, loaded.limits.ori_question_max_chars)
                .join(''),
              localization: saved.localization,
              force_refresh: saved.force_refresh,
            };
          }
          // 尚未进行过搜索时，用配置默认值覆盖初始状态
          return searchStateRef.current.status === 'idle'
            ? { ...defaults, force_refresh: prev.force_refresh }
            : { ...prev, count: clampSettingCount(prev.count, loaded) };
        });
      } catch (error) {
        if (error instanceof AbortedError) {
          return;
        }
        setConfigFailed(true);
        setConfig(FALLBACK_CONFIG);
        configRef.current = FALLBACK_CONFIG;
      } finally {
        if (!controller.signal.aborted) {
          setConfigSettled(true);
        }
      }
    })();
    return () => {
      controller.abort();
    };
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 执行一次搜索 */
  /** token 失效：清空并回到门禁 */
  const requirePasswordAgain = useCallback((): void => {
    clearAuthToken();
    setAuthRequired(true);
    setAuthNotice('访问密码已失效，请重新输入');
    setAuthError(null);
  }, []);

  const runSearch = useCallback(
    (rawQuery: string, options: { settings: SearchSettings; echo: RequestEcho; syncUrl: boolean }): void => {
      const queryValidation = validateQuery(rawQuery, limits.query_max_chars);
      if (!queryValidation.ok) {
        setQueryError(queryValidation.error ?? '关键词不合法');
        return;
      }
      setQueryError(null);
      setSettingsError(null);

      const oriValidation = validateOriQuestion(
        options.settings.ori_question,
        limits.ori_question_max_chars,
      );
      if (!oriValidation.ok) {
        setSettingsError(oriValidation.error);
        return;
      }
      const locValidation = validateLocalization(options.settings.localization);
      if (!locValidation.ok) {
        setSettingsError(locValidation.error);
        return;
      }
      const countValidation = validateCount(options.settings.count, limits);
      if (countValidation.error !== null) {
        setSettingsError(countValidation.error);
        return;
      }

      // 取消上一次搜索：旧响应绝不能覆盖新结果
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;

      setSearchState({
        status: 'loading',
        query: queryValidation.value,
        echo: options.echo,
        envelope: null,
        error: null,
      });

      if (options.syncUrl) {
        pushSearchState(queryValidation.value);
      }

      void (async (): Promise<void> => {
        try {
          const envelope = await searchApi(
            {
              query: queryValidation.value,
              count: countValidation.value,
              need_content: options.settings.need_content,
              ori_question:
                oriValidation.value === '' ? null : oriValidation.value,
              localization: locValidation.value === '' ? null : locValidation.value,
              force_refresh: options.settings.force_refresh,
            },
            { signal: controller.signal },
          );
          if (controller.signal.aborted) {
            return;
          }
          setSearchState({
            status: 'success',
            query: queryValidation.value,
            echo: options.echo,
            envelope,
            error: null,
          });
        } catch (error) {
          if (controller.signal.aborted || error instanceof AbortedError) {
            return;
          }
          if (isUnauthorizedError(error)) {
            requirePasswordAgain();
            setSearchState(INITIAL_SEARCH_STATE);
            return;
          }
          const apiError =
            error instanceof ApiError
              ? error
              : new ApiError({ code: 'internal_error', message: '搜索失败，请稍后重试' });
          setSearchState({
            status: 'error',
            query: queryValidation.value,
            echo: options.echo,
            envelope: null,
            error: apiError,
          });
        }
      })();
    },
    [limits],
  );

  /** 由当前 query + settings 组合请求回显 */
  const buildEcho = useCallback(
    (rawQuery: string, currentSettings: SearchSettings): RequestEcho => ({
      query: rawQuery.trim(),
      count: currentSettings.count,
      need_content: currentSettings.need_content,
      ori_question: currentSettings.ori_question.trim() === '' ? null : currentSettings.ori_question.trim(),
      localization: currentSettings.localization.trim() === '' ? null : currentSettings.localization.trim(),
      force_refresh: currentSettings.force_refresh,
    }),
    [],
  );

  /** 提交搜索 */
  const handleSubmit = useCallback((): void => {
    const validation = validateQuery(query, limits.query_max_chars);
    if (!validation.ok) {
      setQueryError(validation.error);
      inputRef.current?.focus();
      return;
    }
    const effectiveQuery = validation.value;
    setQuery(effectiveQuery);
    setInvalidUrl(null);
    setSettingsError(null);
    runSearch(effectiveQuery, {
      settings,
      echo: buildEcho(effectiveQuery, settings),
      syncUrl: true,
    });
    saveSettings(settings);
  }, [buildEcho, limits.query_max_chars, query, runSearch, settings]);

  /** 从 URL 恢复并重新搜索（popstate / 首屏） */
  const restoreFromUrl = useCallback(
    (searchString: string, options: { autoSearch: boolean }): void => {
      // 关键词上限优先取 /api/config（与后端常量保持一致），避免两处硬编码漂移
      const maxQueryChars =
        configRef.current?.limits.query_max_chars ?? FALLBACK_LIMITS.query_max_chars;
      const parsed = readUrlState(searchString, maxQueryChars);
      if (parsed.status === 'valid') {
        setInvalidUrl(null);
        setQuery(parsed.query);
        const baseSettings = defaultsFromConfig(configRef.current);
        const merged: SearchSettings = {
          ...baseSettings,
          force_refresh: settings.force_refresh,
        };
        setSettings(merged);
        runSearch(parsed.query, {
          settings: merged,
          echo: buildEcho(parsed.query, merged),
          syncUrl: false,
        });
        return;
      }
      if (parsed.status === 'invalid') {
        setInvalidUrl({ raw: parsed.raw, reason: parsed.reason });
      } else {
        setInvalidUrl(null);
      }
      // popstate 回到落地页（或地址里的 s 非法）时，当前可能仍有在途搜索：
      // 必须中止，否则旧响应返回后会把结果填到落地页，造成 URL 与界面状态不一致。
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      if (options.autoSearch) {
        // 无合法 s：停留落地页，不自动搜索
        setSearchState(INITIAL_SEARCH_STATE);
      }
    },
    [buildEcho, runSearch, settings.force_refresh],
  );

  // 首屏：解析 URL 并在 /api/config 落定后自动搜索
  // （先取配置可确保 count / need_content 等默认值优先来自接口）
  useEffect(() => {
    if (bootstrappedRef.current || !configSettled) {
      return;
    }
    bootstrappedRef.current = true;
    // 读取当前地址栏状态（内部已处理无 window 的环境）
    const parsed = readUrlState(
      undefined,
      configRef.current?.limits.query_max_chars ?? FALLBACK_LIMITS.query_max_chars,
    );
    if (parsed.status === 'valid') {
      setQuery(parsed.query);
      const merged: SearchSettings = {
        ...defaultsFromConfig(configRef.current),
        force_refresh: false,
      };
      setSettings(merged);
      runSearch(parsed.query, {
        settings: merged,
        echo: buildEcho(parsed.query, merged),
        syncUrl: false,
      });
    } else if (parsed.status === 'invalid') {
      setInvalidUrl({ raw: parsed.raw, reason: parsed.reason });
    }
    // 配置落定后仅执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configSettled]);

  // popstate：前进/后退恢复并重新搜索
  useEffect(() => {
    const onPopState = (): void => {
      restoreFromUrl(window.location.search, { autoSearch: true });
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, [restoreFromUrl]);

  // 卸载时中止在途请求
  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      fetchAbortRef.current?.abort();
    };
  }, []);

  // “/” 聚焦搜索框
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  /** 打开抓取抽屉 */
  const startFetch = useCallback(
    (target: FetchTarget, force: boolean): void => {
      // 纵深防御：结果里的 URL 虽已规范化，这里再校验协议与长度，
      // 避免未来新增调用方绕过 safeUrl 直接传入外部字符串。
      const urlCheck = validateFetchUrl(target.url, limits.fetch_url_max_chars);
      if (!urlCheck.ok) {
        notify('链接不合法，无法抓取', 'error');
        return;
      }
      const safeTarget: FetchTarget = { url: urlCheck.value, title: target.title };

      const active = typeof document === 'undefined' ? null : document.activeElement;
      lastFetchTriggerRef.current = active instanceof HTMLElement ? active : null;

      fetchAbortRef.current?.abort();
      const controller = new AbortController();
      fetchAbortRef.current = controller;

      setFetchState({
        open: true,
        target: safeTarget,
        force,
        status: 'loading',
        envelope: null,
        error: null,
      });

      void (async (): Promise<void> => {
        try {
          const envelope = await fetchUrl(
            { url: safeTarget.url, force_refresh: force },
            { signal: controller.signal },
          );
          if (controller.signal.aborted) {
            return;
          }
          setFetchState((prev) => ({
            ...prev,
            status: 'success',
            envelope,
            error: null,
          }));
        } catch (error) {
          if (controller.signal.aborted || error instanceof AbortedError) {
            return;
          }
          const apiError =
            error instanceof ApiError
              ? error
              : new ApiError({ code: 'internal_error', message: '抓取失败，请稍后重试' });
          setFetchState((prev) => ({
            ...prev,
            status: 'error',
            envelope: null,
            error: apiError,
          }));
        }
      })();
    },
    [limits.fetch_url_max_chars, notify],
  );

  const handleFetch = useCallback(
    (url: string, title: string | null): void => {
      startFetch({ url, title }, false);
    },
    [startFetch],
  );

  const handleFetchRetry = useCallback((): void => {
    const target = fetchState.target;
    if (target === null) {
      return;
    }
    startFetch(target, fetchState.force);
  }, [fetchState.force, fetchState.target, startFetch]);

  const handleFetchClose = useCallback((): void => {
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;
    // 必须彻底复位：若关闭时仍在 loading，中止后的 catch 不会更新状态，
    // 卡片会因 fetchingUrl 仍指向该 URL 而永久停在「抓取中」禁用态。
    setFetchState({ ...INITIAL_FETCH_STATE });
  }, []);

  const returnFocusToTrigger = useCallback((): void => {
    const trigger = lastFetchTriggerRef.current;
    if (trigger !== null && document.contains(trigger)) {
      trigger.focus();
      return;
    }
    inputRef.current?.focus();
  }, []);

  /** 复制分享链接 */
  const handleShare = useCallback(
    (result: NormalizedResult): void => {
      const shareUrl = buildShareUrl(searchState.query);
      void (async (): Promise<void> => {
        const ok = await copyText(shareUrl);
        if (ok) {
          const title = result.title;
          notify(
            title === null ? '已复制分享链接' : `已复制「${truncateForToast(title)}」的搜索分享链接`,
            'success',
          );
        } else {
          notify('复制失败，请手动复制地址栏链接', 'error');
        }
      })();
    },
    [notify, searchState.query],
  );

  const handleSettingsChange = useCallback(
    (patch: Partial<SearchSettings>): void => {
      setSettingsError(null);
      setSettings((prev) => {
        const next: SearchSettings = { ...prev, ...patch };
        const countValidation = validateCount(next.count, limits, prev.count);
        if (countValidation.error !== null) {
          setSettingsError(countValidation.error);
          return { ...next, count: countValidation.value };
        }
        return next;
      });
    },
    [limits],
  );

  const handleResetSettings = useCallback((): void => {
    const defaults = defaultsFromConfig(configRef.current);
    setSettings(defaults);
    savedSettingsRef.current = null;
    // 同时清除本地偏好，避免刷新后又被旧值覆盖
    clearSettings();
    setSettingsError(null);
    notify('已恢复默认设置', 'success');
  }, [notify]);

  const handleInsertSyntax = useCallback((example: string): void => {
    setQuery((prev) => appendSyntaxExample(prev, example));
    inputRef.current?.focus();
  }, []);

  const handleClearQuery = useCallback((): void => {
    setQuery('');
    setQueryError(null);
    inputRef.current?.focus();
  }, []);

  const closeSyntaxModal = useCallback((): void => {
    setSyntaxModalOpen(false);
  }, []);

  const closeSettingsModal = useCallback((): void => {
    setSettingsModalOpen(false);
  }, []);

  /** 提交访问密码换取 token；成功后放行到正常界面 */
  const handlePasswordSubmit = useCallback((password: string): void => {
    setAuthLoading(true);
    setAuthError(null);
    void (async (): Promise<void> => {
      try {
        const result = await loginApi(password);
        setAuthToken(result.token);
        setAuthNotice(null);
        setAuthRequired(false);
        // 放行后把焦点交给搜索框
        window.setTimeout(() => {
          inputRef.current?.focus();
        }, 0);
      } catch (error) {
        if (error instanceof AbortedError) {
          return;
        }
        const message =
          error instanceof ApiError && error.code === 'invalid_password'
            ? '访问密码错误，请重试'
            : error instanceof ApiError && error.code === 'rate_limited'
              ? '尝试过于频繁，请稍后再试'
              : '验证失败，请稍后重试';
        setAuthError(message);
      } finally {
        setAuthLoading(false);
      }
    })();
  }, []);

  /** 返回首页：中止在途请求、清空搜索态与关键词 */
  const handleHome = useCallback((): void => {
    searchAbortRef.current?.abort();
    setSearchState(INITIAL_SEARCH_STATE);
    setInvalidUrl(null);
    setQuery('');
    setQueryError(null);
    pushLandingState();
    inputRef.current?.focus();
  }, []);

  const handleRetrySearch = useCallback((): void => {
    const echo = searchState.echo;
    if (echo === null) {
      handleSubmit();
      return;
    }
    const currentSettings: SearchSettings = {
      count: echo.count,
      need_content: echo.need_content,
      ori_question: echo.ori_question ?? '',
      localization: echo.localization ?? '',
      force_refresh: true,
    };
    setSettings(currentSettings);
    runSearch(searchState.query, {
      settings: currentSettings,
      echo,
      syncUrl: true,
    });
  }, [handleSubmit, runSearch, searchState.echo, searchState.query]);

  const handleExample = useCallback(
    (example: string): void => {
      setQuery(example);
      setInvalidUrl(null);
      runSearch(example, {
        settings,
        echo: buildEcho(example, settings),
        syncUrl: true,
      });
    },
    [buildEcho, runSearch, settings],
  );

  const isSearchView = searchState.status !== 'idle';
  // 示例与小提示仅在首页且输入框为空时显示
  const showLanding = !isSearchView && query.trim() === '';
  const mergedSettingsError = settingsError;

  // 状态播报文本
  const liveMessage = useMemo((): string => {
    if (searchState.status === 'loading') {
      return `正在搜索「${searchState.query}」`;
    }
    if (searchState.status === 'success') {
      return `搜索完成，共 ${String(searchState.envelope?.results.length ?? 0)} 条结果`;
    }
    if (searchState.status === 'error') {
      return `搜索失败：${searchState.error?.message ?? '未知错误'}`;
    }
    return '';
  }, [searchState]);

  const showConfigWarning = configFailed;

  // 设置是否偏离默认值（用于在「高级」按钮上给出提示）
  const settingsDirty = useMemo((): boolean => {
    const defaults = defaultsFromConfig(config);
    return (
      settings.count !== defaults.count ||
      settings.need_content !== defaults.need_content ||
      settings.ori_question.trim() !== '' ||
      settings.localization.trim() !== '' ||
      settings.force_refresh
    );
  }, [config, settings]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>

      <main
        id="main-content"
        className={
          authRequired ? 'app-main' : isSearchView ? 'app-main app-main-search' : 'app-main'
        }
        tabIndex={-1}
      >
        {/* 页面唯一 h1：视觉上隐藏，供屏幕阅读器 / SEO 建立标题层级 */}
        <h1 className="sr-only">AI 搜索平台</h1>
        <div
          className={
            authRequired
              ? 'container container-landing'
              : isSearchView
                ? 'container container-wide container-search'
                : 'container container-landing'
          }
        >
          {authRequired ? (
            <PasswordGate
              onSubmit={handlePasswordSubmit}
              loading={authLoading}
              error={authError}
              inputRef={passwordInputRef}
              notice={authNotice}
            />
          ) : (
            <>

          {showConfigWarning ? (
            <div className="notice notice-warn" role="status">
              <InfoIcon size={18} />
              <span>无法获取 /api/config，已使用内置默认配置。</span>
            </div>
          ) : null}

          {invalidUrl !== null ? (
            <div className="notice notice-error" role="alert">
              <WarningIcon size={18} />
              <span>
                地址中的搜索参数无效，已停留在首页且未自动搜索。
                {invalidUrl.reason !== '' ? `（${invalidUrl.reason}）` : ''}
              </span>
            </div>
          ) : null}

          <SearchForm
            query={query}
            onQueryChange={(value) => {
              setQuery(value);
              if (queryError !== null) {
                setQueryError(null);
              }
            }}
            onSubmit={handleSubmit}
            onClear={handleClearQuery}
            loading={searchState.status === 'loading'}
            onOpenSyntax={() => {
              setSyntaxModalOpen(true);
            }}
            onOpenSettings={() => {
              setSettingsModalOpen(true);
            }}
            inputRef={inputRef}
            maxChars={limits.query_max_chars}
            countChars={countChars}
            compact={isSearchView}
            queryError={queryError}
            settingsDirty={settingsDirty}
          />

          {showLanding ? (
            <section className="landing-extra" aria-label="使用提示">
              <div className="landing-card">
                <h2 className="landing-card-title">试试这些示例</h2>
                <div className="landing-examples">
                  {LANDING_EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className="chip"
                      onClick={() => {
                        handleExample(example);
                      }}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
              <div className="landing-card">
                <h2 className="landing-card-title">小提示</h2>
                <ul className="landing-tips">
                  <li>
                    按 <kbd>/</kbd> 快速聚焦搜索框。
                  </li>
                  <li>
                    搜索链接可分享：关键词编码在地址栏的 <code>s</code> 参数中。
                  </li>
                  <li>单次最多返回 50 条结果，可在「高级」中调整数量。</li>
                </ul>
              </div>
            </section>
          ) : null}

          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {liveMessage}
          </div>

          {searchState.status === 'loading' ? <Skeleton rows={3} /> : null}

          {searchState.status === 'error' && searchState.error !== null ? (
            <ErrorBanner
              error={searchState.error}
              onRetry={handleRetrySearch}
              notify={notify}
              retrying={false}
            />
          ) : null}

          {searchState.status === 'success' && searchState.envelope !== null ? (
            searchState.envelope.results.length === 0 && Object.keys(searchState.envelope.extraTop).length > 0 ? (
              <EmptyState
                title="响应中没有结果列表"
                description="后端返回了无法识别的响应结构，可展开原始响应 JSON 查看详情。"
              />
            ) : (
              <ResultList
                envelope={searchState.envelope}
                onFetch={handleFetch}
                notify={notify}
                fetchingUrl={
                  fetchState.status === 'loading' ? fetchState.target?.url ?? null : null
                }
                onShare={handleShare}
                query={searchState.query}
              />
            )
          ) : null}
            </>
          )}
        </div>
      </main>

      {/* 搜索页浮动操作：返回首页（首页不显示） */}
      {isSearchView ? (
        <button
          type="button"
          className="theme-fab home-fab tip tip-r"
          onClick={handleHome}
          data-tip="返回首页"
          aria-label="返回首页"
        >
          <HomeIcon size={18} />
        </button>
      ) : null}

      {/* 主题切换（无顶栏后的轻量入口） */}
      <button
        type="button"
        className="theme-fab tip tip-r"
        onClick={() => {
          setThemeMode((prev) => nextThemeMode(prev));
        }}
        data-tip={`主题：${THEME_LABELS[themeMode]}`}
        aria-label={`主题：${THEME_LABELS[themeMode]}，点击切换`}
      >
        {themeMode === 'light' ? (
          <SunIcon size={18} />
        ) : themeMode === 'dark' ? (
          <MoonIcon size={18} />
        ) : (
          <AutoThemeIcon size={18} />
        )}
      </button>

      {/* 搜索语法（模态框） */}
      <Modal
        open={syntaxModalOpen}
        title="搜索语法"
        description="支持 8 个操作符，可组合使用；点击「插入示例」追加到关键词。"
        onClose={closeSyntaxModal}
        size="wide"
      >
        <SyntaxHelp
          onInsert={(example) => {
            handleInsertSyntax(example);
            setSyntaxModalOpen(false);
          }}
          notify={notify}
        />
      </Modal>

      {/* 高级搜索（模态框） */}
      <Modal
        open={settingsModalOpen}
        title="高级搜索"
        description={`全部请求字段；默认值来自${config !== null ? ' /api/config' : '内置兜底配置'}。`}
        onClose={closeSettingsModal}
      >
        <AdvancedSettings
          settings={settings}
          config={config}
          limits={{
            count_min: limits.count_min,
            count_max: limits.count_max,
            ori_question_max_chars: limits.ori_question_max_chars,
          }}
          onChange={handleSettingsChange}
          onReset={handleResetSettings}
          error={mergedSettingsError}
          countChars={countChars}
        />
      </Modal>

      <FetchDrawer
        open={fetchState.open}
        target={fetchState.target}
        status={fetchState.status}
        envelope={fetchState.envelope}
        error={fetchState.error}
        onClose={handleFetchClose}
        onRetry={handleFetchRetry}
        notify={notify}
        returnFocusTo={returnFocusToTrigger}
      />

      {toastView}
    </div>
  );
}

function clampSettingCount(value: number, config: AppConfig): number {
  const next = normalizeSettings({ count: value }, config.limits);
  return next.count;
}

function truncateForToast(value: string): string {
  const chars = [...value];
  if (chars.length <= 18) {
    return value;
  }
  return `${chars.slice(0, 18).join('')}…`;
}
