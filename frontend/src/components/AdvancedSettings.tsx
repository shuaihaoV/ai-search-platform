/**
 * 高级设置（模态框内容）：覆盖所有请求字段，含默认值与“恢复默认值”。
 *
 * 字段：count / need_content / ori_question / localization / force_refresh。
 * 由 App 通过 <Modal> 包裹，自身不再有展开/收起。
 */

import type { ReactElement } from 'react';
import type { AppConfig, SearchSettings } from '../types';
import { FALLBACK_DEFAULTS } from '../lib/validation';
import { RefreshIcon } from './Icons';

interface AdvancedSettingsProps {
  settings: SearchSettings;
  config: AppConfig | null;
  limits: { count_min: number; count_max: number; ori_question_max_chars: number };
  onChange: (patch: Partial<SearchSettings>) => void;
  onReset: () => void;
  error: string | null;
  countChars: (value: string) => number;
}

export function AdvancedSettings({
  settings,
  config,
  limits,
  onChange,
  onReset,
  error,
  countChars,
}: AdvancedSettingsProps): ReactElement {
  const oriLength = countChars(settings.ori_question);

  return (
    <div className="settings-body">
      <div className="settings-grid">
        <div className="field">
          <label className="field-label" htmlFor="field-count">
            结果数量 <span className="field-key">count</span>
          </label>
          <input
            id="field-count"
            className="field-input"
            type="number"
            inputMode="numeric"
            min={limits.count_min}
            max={limits.count_max}
            step={1}
            value={settings.count}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(next)) {
                onChange({ count: next });
              } else {
                onChange({ count: limits.count_min });
              }
            }}
          />
          <p className="field-hint">
            范围 {limits.count_min}~{limits.count_max}，默认{' '}
            {config?.defaults.count ?? FALLBACK_DEFAULTS.count}
            ；上限 {limits.count_max}，提高可一次获取更多结果（上游不支持分页，单次上限{' '}
            {limits.count_max} 条）。
          </p>
        </div>

        <div className="field">
          <span className="field-label">
            返回正文 <span className="field-key">need_content</span>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={settings.need_content}
              onChange={(event) => {
                onChange({ need_content: event.target.checked });
              }}
            />
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
            <span className="switch-label">{settings.need_content ? '开启' : '关闭'}</span>
          </label>
          <p className="field-hint">默认开启；关闭后结果不返回正文 content</p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="field-localization">
            地区 <span className="field-key">localization</span>
          </label>
          <input
            id="field-localization"
            className="field-input"
            type="text"
            value={settings.localization}
            placeholder={
              (config?.defaults.localization ?? '') === ''
                ? '如：US / CN / JP，留空则不指定'
                : config?.defaults.localization
            }
            maxLength={64}
            onChange={(event) => {
              onChange({ localization: event.target.value });
            }}
          />
          <p className="field-hint">可选；留空表示不传该字段</p>
        </div>

        <div className="field">
          <span className="field-label">
            强制刷新 <span className="field-key">force_refresh</span>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={settings.force_refresh}
              onChange={(event) => {
                onChange({ force_refresh: event.target.checked });
              }}
            />
            <span className="switch-track" aria-hidden="true">
              <span className="switch-thumb" />
            </span>
            <span className="switch-label">{settings.force_refresh ? '开启' : '关闭'}</span>
          </label>
          <p className="field-hint">非上游字段：仅绕过服务端缓存，不传给上游</p>
        </div>

        <div className="field field-wide">
          <label className="field-label" htmlFor="field-ori-question">
            原始问题 <span className="field-key">ori_question</span>
          </label>
          <textarea
            id="field-ori-question"
            className="field-input field-textarea"
            value={settings.ori_question}
            placeholder="可选：用于重排/召回的原始问题，留空则不传"
            maxLength={limits.ori_question_max_chars}
            rows={2}
            onChange={(event) => {
              onChange({ ori_question: event.target.value });
            }}
          />
          <p
            className={
              oriLength > limits.ori_question_max_chars
                ? 'field-hint field-hint-error'
                : 'field-hint'
            }
          >
            {oriLength} / {limits.ori_question_max_chars} 字符
          </p>
        </div>
      </div>

      <div className="settings-foot">
        <button type="button" className="btn btn-ghost" onClick={onReset}>
          <RefreshIcon size={16} />
          <span>恢复默认值</span>
        </button>
        {error !== null ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
