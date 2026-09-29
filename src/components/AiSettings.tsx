import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { api } from "../api";
import { AI_ROLES, type AiModel, type AiRole } from "../types";

/** Choosing who sees, who hears and who thinks.
 *
 * Three separate choices because they are three separate jobs, and no one
 * service is best at all of them — nor, today, even capable of all of
 * them. A model only appears in a role it can actually fill: DeepSeek has
 * no audio endpoint, so it is never offered as the ears, and finding that
 * out here is better than finding it out when a transcription fails.
 *
 * Keys are asked for once per provider, not once per model. One DeepSeek
 * key buys both of its models; the key entered for Groq's Whisper is the
 * same key any other Groq model would use.
 *
 * This component owns its own state and talks to the backend directly.
 * None of it belongs to the project — which theme, which model, and whose
 * bill are properties of the person editing, not of the film.
 */
export function AiSettings({ onClose }: { onClose: () => void }) {
  const [models, setModels] = useState<AiModel[] | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setModels(await api.aiModels());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape shuts it, like every other box in this editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function saveKey(provider: string) {
    setBusy(provider);
    setError(null);
    try {
      setModels(await api.saveAiKey(provider, typed[provider] ?? ""));
      // The field is cleared whether a key went in or came out: what is
      // stored is never shown again, so leaving the typing there would
      // suggest it is what the app holds.
      setTyped((current) => ({ ...current, [provider]: "" }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function pick(role: AiRole, id: string) {
    if (!id) return;
    setError(null);
    try {
      setModels(await api.chooseAiModel(role, id));
    } catch (e) {
      setError(String(e));
    }
  }

  /** One card per provider, since that is what a key belongs to. */
  const providers = (models ?? []).reduce<
    { id: string; name: string; keysAt: string; hasKey: boolean; models: AiModel[] }[]
  >((out, model) => {
    const seen = out.find((p) => p.id === model.provider);
    if (seen) {
      seen.models.push(model);
      return out;
    }
    out.push({
      id: model.provider,
      name: model.providerName,
      keysAt: model.keysAt,
      hasKey: model.hasKey,
      models: [model],
    });
    return out;
  }, []);

  return (
    <div
      className="ed-modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ed-modal ed-ai" role="dialog" aria-modal="true" aria-label="AI providers">
        <div className="ed-modal-head">
          <h2>AI providers</h2>
          <button className="ed-iconbtn" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="ed-note">
          Three jobs, chosen separately. A model is only offered for a job it
          can actually do — a chat model cannot hear, however good it is at
          everything else.
        </p>

        {error && <div className="ed-ai-error">{error}</div>}

        <div className="ed-roles">
          {AI_ROLES.map((role) => {
            const able = (models ?? []).filter((m) => m.roles.includes(role.id));
            const chosen = able.find((m) => m.chosenFor.includes(role.id));
            return (
              <div className="ed-role" key={role.id}>
                <div className="ed-role-head">
                  <span className="ed-role-name">{role.label}</span>
                  <select
                    className="ed-input ed-role-pick"
                    value={chosen?.id ?? ""}
                    onChange={(e) => void pick(role.id, e.currentTarget.value)}
                  >
                    <option value="">Not chosen yet</option>
                    {able.map((model) => (
                      <option key={model.id} value={model.id} disabled={!model.hasKey}>
                        {model.providerName} · {model.model}
                        {model.hasKey ? "" : " — needs a key"}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="ed-role-what">{role.what}</p>
              </div>
            );
          })}
        </div>

        <h3 className="ed-ai-heading">Keys</h3>
        <p className="ed-note">
          One key per provider, whatever you use it for. Keys are kept in
          this app's own settings folder — never in a project file, and never
          shown again once entered.
        </p>

        <div className="ed-engines">
          {providers.map((provider) => (
            <div
              className={`ed-engine ${provider.hasKey ? "is-default" : ""}`}
              key={provider.id}
            >
              <div className="ed-engine-head">
                <span className="ed-engine-name">{provider.name}</span>
                <span className={`ed-engine-state ${provider.hasKey ? "is-set" : ""}`}>
                  {provider.hasKey ? "key saved" : "no key"}
                </span>
              </div>
              <p className="ed-engine-note">
                {provider.models.map((m) => m.model).join(" · ")}
              </p>
              <div className="ed-engine-key">
                <input
                  className="ed-input"
                  type="password"
                  placeholder={provider.hasKey ? "Replace the key" : "Paste a key"}
                  value={typed[provider.id] ?? ""}
                  onChange={(e) => {
                    // Read before the updater runs: the event is pooled,
                    // and reaching for it inside would find it emptied.
                    const value = e.currentTarget.value;
                    setTyped((current) => ({ ...current, [provider.id]: value }));
                  }}
                />
                <button
                  className="ed-pill"
                  disabled={busy === provider.id}
                  onClick={() => void saveKey(provider.id)}
                >
                  {(typed[provider.id] ?? "").trim().length > 0 ? "Save" : "Remove"}
                </button>
              </div>
              <button
                className="ed-engine-link"
                onClick={() => void openUrl(provider.keysAt)}
              >
                Where to get a key
              </button>
            </div>
          ))}
        </div>

        {models === null && !error && <p className="ed-note">Reading the list…</p>}
      </div>
    </div>
  );
}
