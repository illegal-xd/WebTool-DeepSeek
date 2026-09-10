import { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemPromptPreset } from '../../../core/types';
import { sortPresetsByWeight } from '../../../core/weighting';
import PresetCard from '../components/PresetCard';
import PresetForm from '../components/PresetForm';
import SidepanelModal from '../components/SidepanelModal';
import Skeleton from '../components/ui/Skeleton';

export default function PresetPage() {
  const [presets, setPresets] = useState<SystemPromptPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SystemPromptPreset | undefined>();
  const [isFormWide, setIsFormWide] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list: SystemPromptPreset[] = await chrome.runtime.sendMessage({ type: 'GET_PRESETS' });
      setPresets(list ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const listener = (message: any) => {
      if (message.type === 'STATE_UPDATED') {
        load();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [load]);

  const handleSave = async (preset: SystemPromptPreset) => {    await chrome.runtime.sendMessage({ type: 'SAVE_PRESET', payload: preset });
    setShowForm(false);
    setEditing(undefined);
    setIsFormWide(false);
    load();
  };

  const handleImportFiles = async (files: FileList) => {
    const entries = await Promise.all(
      Array.from(files, async (file) => ({
        name: file.name.replace(/\.(txt|md)$/i, '').trim(),
        content: (await file.text()).trim(),
      })),
    );
    for (const { name, content } of entries) {
      if (!content) continue;
      const now = Date.now();
      await chrome.runtime.sendMessage({
        type: 'SAVE_PRESET',
        payload: {
          id: crypto.randomUUID(),
          name,
          content,
          createdAt: now,
          updatedAt: now,
        } satisfies SystemPromptPreset,
      });
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
    load();
  };

  const handleDelete = async (id: string) => {
    if (editing?.id === id) {
      setEditing(undefined);
      setShowForm(false);
      setIsFormWide(false);
    }
    await chrome.runtime.sendMessage({ type: 'DELETE_PRESET', payload: { id } });
    load();
  };

  const handleEdit = (preset: SystemPromptPreset) => {
    setEditing(preset);
    setShowForm(true);
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditing(undefined);
    setIsFormWide(false);
  };

  return (
    <div className="p-4 space-y-4">
      <div
        className="sticky top-0 z-10 flex items-center justify-between border-b"
        style={{
          backgroundColor: 'var(--ds-bg)',
          borderColor: 'var(--ds-border)',
          margin: '-16px -16px 8px -16px',
          padding: '12px 16px',
        }}
      >
        <h2 className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>
          系统提示词预设
        </h2>
        <div className="flex items-center gap-1.5 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md"
            multiple
            className="hidden"
            onChange={(e) => e.target.files?.length && handleImportFiles(e.target.files)}
          />
          {/* <button
            onClick={() => fileInputRef.current?.click()}
            className="ds-btn-cancel px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 flex items-center gap-1"
          >
            <svg aria-hidden="true" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            导入
          </button> */}
          <button
            type="button"
            onClick={() => { setEditing(undefined); setShowForm(!showForm); }}
            className="ds-btn-primary px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150 flex items-center gap-1"
          >
            <svg aria-hidden="true" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            新建
          </button>
        </div>
      </div>

      <SidepanelModal open={showForm} title={editing ? '编辑系统预设' : '新建系统预设'} maxWidth={isFormWide ? 'lg' : 'md'} onClose={handleCancel}>
        <PresetForm
          key={editing ? `edit-${editing.id}` : 'new'}
          initial={editing}
          onSave={handleSave}
          onCancel={handleCancel}
          onWidthChange={setIsFormWide}
        />
      </SidepanelModal>

      <div className="ds-list-in space-y-2">
        {loading ? (
          <Skeleton lines={3} />
        ) : (
          sortPresetsByWeight(presets).map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              onEdit={() => handleEdit(p)}
              onDelete={() => handleDelete(p.id)}
            />
          ))
        )}
      </div>

      {presets.length === 0 && !showForm && (
        <div className="ds-info-panel rounded-xl p-3.5">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
            创建系统提示词预设后，在输入框用 <span className="font-medium">@预设名</span> 引用即可生效，随用随选、不保留启用状态。
          </p>
        </div>
      )}

      <div className="ds-info-panel rounded-xl p-3.5">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
          在 DeepSeek 输入框中输入{' '}
          <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">
            @
          </code>{' '}
          唤起预设列表：选中后会在输入框内显示{' '}
          <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">
            @预设名
          </code>{' '}
          文案，该预设<span className="font-medium">仅对这一条消息生效</span>（发送时自动识别并剥离，无需手动删除）。
        </p>
      </div>
    </div>
  );
}
