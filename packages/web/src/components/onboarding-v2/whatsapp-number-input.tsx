import { useTheme } from "@sketch/ui";
import { useState } from "react";

interface WhatsAppNumberInputProps {
  onSubmit: (fullNumber: string) => void;
  /** Inline helper text shown below the inputs. Defaults to the admin-flow copy. */
  helpText?: string;
  /** Called when the user opts to defer WhatsApp setup. Renders a small ghost link below the CTA;
   *  when undefined, no escape hatch is shown (e.g. WhatsApp is mandatory for the chosen auth method). */
  onSkip?: () => void;
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** Format the number digits based on country code: +91 → "XXXXX XXXXX", everything else → "XXX XXX XXXX". */
function formatNumber(digits: string, code: string): string {
  const isIndia = digitsOnly(code) === "91";
  if (isIndia) {
    if (digits.length <= 5) return digits;
    return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

function WhatsAppIcon({ size = 14, color = "#25D366" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

/** Step 2 sub-step: capture the admin's own WhatsApp number before pairing the bot host number via QR. */
export function WhatsAppNumberInput({
  onSubmit,
  helpText = "I'll save this as the admin's number.",
  onSkip,
}: WhatsAppNumberInputProps) {
  const { resolvedTheme } = useTheme();
  const [code, setCode] = useState("");
  // Stored as digits only; the displayed value is formatted based on country code.
  const [numberDigits, setNumberDigits] = useState("");
  const [touched, setTouched] = useState({ code: false, number: false });

  const codeDigits = digitsOnly(code);
  const number = formatNumber(numberDigits, code);

  // Country code 1-3 digits. Number must be exactly 10 digits.
  const codeValid = codeDigits.length >= 1 && codeDigits.length <= 3;
  const numberValid = numberDigits.length === 10;
  const canSubmit = codeValid && numberValid;

  const codeError = touched.code && code.length > 0 && !codeValid;
  const numberError = touched.number && number.length > 0 && !numberValid;
  const showError = codeError || numberError;

  const handleSubmit = () => {
    if (!canSubmit) {
      setTouched({ code: true, number: true });
      return;
    }
    const codeNormalized = code.trim().startsWith("+") ? code.trim() : `+${codeDigits}`;
    onSubmit(`${codeNormalized} ${number.trim()}`);
  };

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-wa-numcard">
        <div className="ob-wa-numcard-header">
          <WhatsAppIcon size={14} color={resolvedTheme === "dark" ? "#feed01" : "#6b6200"} />
          WHATSAPP
        </div>

        <div className="ob-wa-numcard-row">
          <input
            type="text"
            className="ob-wa-numcard-input ob-wa-numcard-code"
            data-state={codeError ? "error" : undefined}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="+01"
            inputMode="tel"
            aria-label="Country code"
            aria-invalid={codeError}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
          />
          <input
            type="tel"
            className="ob-wa-numcard-input ob-wa-numcard-number"
            data-state={numberError ? "error" : undefined}
            value={number}
            onChange={(e) => {
              const nextDigits = digitsOnly(e.target.value);
              if (nextDigits.length > 10) return;
              setNumberDigits(nextDigits);
            }}
            placeholder="555 234 5678"
            inputMode="tel"
            autoComplete="tel-national"
            aria-invalid={numberError}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
          />
        </div>

        {showError ? (
          <div className="ob-wa-numcard-help ob-wa-numcard-help-error">
            That doesn't look like a valid number. Try again?
          </div>
        ) : helpText ? (
          <div className="ob-wa-numcard-help">{helpText}</div>
        ) : null}

        <button
          type="button"
          className="ob-btn ob-btn-primary ob-wa-numcard-cta"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          Continue
        </button>

        {onSkip && (
          <button type="button" className="ob-wa-numcard-skip" onClick={onSkip}>
            Set this up later
          </button>
        )}
      </div>
    </div>
  );
}
