import { useState } from "react";
import type { WhatsAppMember } from "./types";

interface WhatsAppMembersProps {
  onSubmit: (members: WhatsAppMember[]) => void;
}

interface Row {
  id: number;
  name: string;
  phone: string;
}

let rowSeq = 0;
function newRow(): Row {
  return { id: ++rowSeq, name: "", phone: "" };
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

function isRowValid(row: Row): boolean {
  return row.name.trim().length > 0 && digitsOnly(row.phone).length >= 7;
}

/** Step 2 sub-step: admin adds initial teammates whose personal WhatsApp numbers Sketch will message. Min 1 valid row. */
export function WhatsAppMembers({ onSubmit }: WhatsAppMembersProps) {
  const [rows, setRows] = useState<Row[]>(() => [newRow()]);

  const update = (id: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    setRows((prev) => [...prev, newRow()]);
  };

  const removeRow = (id: number) => {
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((r) => r.id !== id)));
  };

  const validCount = rows.filter(isRowValid).length;
  const canSubmit = validCount >= 1;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const valid = rows.filter(isRowValid).map((r) => ({ name: r.name.trim(), phone: r.phone.trim() }));
    onSubmit(valid);
  };

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-api-card ob-wa-members-card">
        <div className="ob-wa-members-headrow">
          <div className="ob-wa-members-collabel ob-wa-members-collabel-name">Name</div>
          <div className="ob-wa-members-collabel ob-wa-members-collabel-phone">Phone</div>
        </div>
        <div className="ob-wa-members-list">
          {rows.map((row, idx) => (
            <div key={row.id} className="ob-wa-member-row">
              <input
                type="text"
                className="ob-api-input ob-wa-member-name"
                value={row.name}
                onChange={(e) => update(row.id, { name: e.target.value })}
                placeholder="Jane Doe"
                aria-label="Name"
                autoComplete="off"
              />
              <input
                type="tel"
                className="ob-api-input ob-wa-member-phone"
                value={row.phone}
                onChange={(e) => update(row.id, { phone: e.target.value })}
                placeholder="+1 555 234 5678"
                aria-label="Phone"
                inputMode="tel"
                autoComplete="off"
              />
              {rows.length > 1 && (
                <button
                  type="button"
                  className="ob-wa-member-remove"
                  onClick={() => removeRow(row.id)}
                  aria-label={`Remove row ${idx + 1}`}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M18 6L6 18" strokeLinecap="round" />
                    <path d="M6 6l12 12" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>

        <button type="button" className="ob-btn ob-btn-ghost ob-wa-member-add" onClick={addRow}>
          + Add another
        </button>

        <button type="button" className="ob-api-btn" data-state="default" onClick={handleSubmit} disabled={!canSubmit}>
          CONTINUE
        </button>
      </div>
    </div>
  );
}
