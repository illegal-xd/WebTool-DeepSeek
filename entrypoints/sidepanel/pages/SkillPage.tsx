import { useEffect, useState } from 'react';
import type { Skill } from '../../../core/types';
import SkillCard from '../components/SkillCard';
import SkillForm from '../components/SkillForm';

function SkillSection({
  title,
  skills,
  collapsible = false,
  onEdit,
  onDelete,
}: {
  title: string;
  skills: Skill[];
  collapsible?: boolean;
  onEdit?: (skill: Skill) => void;
  onDelete?: (name: string) => void;
}) {
  const storageKey = `dpp_skill_section_${title}_expanded`;
  const [isExpanded, setIsExpanded] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored !== 'false';
  });

  const toggleExpanded = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    localStorage.setItem(storageKey, String(next));
  };

  if (skills.length === 0) return null;
  return (
    <div className="space-y-2">
      <div
        className={`flex items-center justify-between ${
          collapsible ? 'cursor-pointer select-none py-0.5 group' : ''
        }`}
        onClick={collapsible ? toggleExpanded : undefined}
      >
        <h3 className="text-[11px] font-medium uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--ds-text-tertiary)' }}>
          <span>{title}</span>
          <span className="text-[10px] opacity-75 font-normal">({skills.length})</span>
        </h3>
        {collapsible && (
          <svg
            className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
            style={{ color: 'var(--ds-text-tertiary)' }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </div>
      {(!collapsible || isExpanded) && (
        <div className="space-y-2 animate-fade-in">
          {skills.map((s) => (
            <SkillCard
              key={s.name}
              skill={s}
              onEdit={onEdit ? () => onEdit(s) : undefined}
              onDelete={onDelete ? () => onDelete(s.name) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function SkillPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [isFormWide, setIsFormWide] = useState(false);

  const load = async () => {
    const list: Skill[] = await chrome.runtime.sendMessage({ type: 'GET_SKILLS' });
    setSkills(list ?? []);
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const mainEl = document.querySelector('main');
    if (!mainEl) return;
    if (showForm || editingSkill) {
      mainEl.style.overflowY = 'hidden';
    } else {
      mainEl.style.overflowY = 'auto';
    }
    return () => {
      mainEl.style.overflowY = 'auto';
    };
  }, [showForm, editingSkill]);

  const handleDelete = async (name: string) => {
    if (editingSkill?.name === name) {
      setEditingSkill(null);
    }
    await chrome.runtime.sendMessage({ type: 'DELETE_SKILL', payload: { name } });
    load();
  };

  const handleSave = async (skill: Skill, oldName?: string) => {
    if (oldName && oldName !== skill.name) {
      await chrome.runtime.sendMessage({ type: 'DELETE_SKILL', payload: { name: oldName } });
    }
    await chrome.runtime.sendMessage({ type: 'SAVE_SKILL', payload: skill });
    setShowForm(false);
    setEditingSkill(null);
    setIsFormWide(false);
    load();
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingSkill(null);
    setIsFormWide(false);
  };

  const builtin = skills.filter((s) => s.source === 'builtin');
  const custom = skills.filter((s) => s.source === 'custom');

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
          可用 Skill
        </h2>
        <button
          onClick={() => {
            if (editingSkill) {
              setEditingSkill(null);
              setShowForm(true);
            } else {
              setShowForm(!showForm);
            }
          }}
          className="ds-btn-primary px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150 flex items-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          自定义
        </button>
      </div>

      {(showForm || editingSkill) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className={`w-full transition-all duration-300 ${isFormWide ? 'max-w-3xl' : 'max-w-md'}`}>
            <div className="animate-slide-down">
              <SkillForm
                key={editingSkill ? `edit-${editingSkill.name}` : 'new'}
                initialSkill={editingSkill || undefined}
                onSave={handleSave}
                onCancel={handleCancel}
                onWidthChange={setIsFormWide}
              />
            </div>
          </div>
        </div>
      )}

      <SkillSection title="内置" skills={builtin} collapsible={true} />
      <SkillSection title="自定义" skills={custom} onEdit={setEditingSkill} onDelete={handleDelete} />

      <div className="ds-info-panel rounded-xl p-3.5">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
          在 DeepSeek 输入框中输入{' '}
          <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">
            /skill名 参数
          </code>{' '}
          触发。例如：
          <code className="ds-code font-mono text-[11px] px-1.5 py-0.5 rounded">
            /frontend-design 做一个登录页
          </code>
        </p>
      </div>
    </div>
  );
}
