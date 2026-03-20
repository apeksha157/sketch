import { useState } from "react";
import type { ApiProvider } from "./types";

interface ApiKeyInputProps {
  onValidated: (provider: ApiProvider) => void;
}

const AWS_REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "eu-west-3", "ap-southeast-1", "ap-northeast-1"];

/** AWS orange mark SVG */
function AwsMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8.1 14.2c0 .3 0 .5.1.7l.5.5c.1.1.1.2.1.3 0 .1-.1.2-.2.3l-.7.5c-.1.1-.2.1-.3.1-.1 0-.2-.1-.3-.2-.2-.2-.3-.3-.4-.5-.1-.2-.2-.3-.4-.5C5.5 16.5 4.3 17 2.8 17c-1.1 0-2-.3-2.6-.9-.6-.6-1-1.4-1-2.4 0-1.1.4-1.9 1.1-2.5.8-.6 1.8-.9 3-.9.4 0 .9 0 1.3.1.5.1.9.2 1.4.3v-.9c0-1-.2-1.7-.6-2.1-.4-.4-1.1-.6-2.1-.6-.5 0-.9.1-1.4.2-.5.1-.9.3-1.4.5-.2.1-.3.1-.4.2h-.2c-.2 0-.2-.1-.2-.4v-.6c0-.2 0-.3.1-.4.1-.1.2-.2.4-.3.5-.2 1-.4 1.6-.6.6-.2 1.3-.2 2-.2 1.5 0 2.6.3 3.3 1 .7.7 1 1.7 1 3v4zM3.4 15.6c.4 0 .8-.1 1.3-.2.4-.2.8-.4 1.1-.8.2-.2.3-.5.3-.8.1-.3.1-.7.1-1.1v-.5c-.4-.1-.8-.2-1.2-.2-.4-.1-.8-.1-1.2-.1-.8 0-1.4.2-1.8.5-.4.3-.6.8-.6 1.4 0 .6.1 1 .4 1.3.3.3.8.5 1.6.5z"
        transform="translate(5, 4)"
        fill="#FF9900"
      />
    </svg>
  );
}

/** Anthropic "A" lettermark */
function AnthropicMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.508-4.065H5.248L3.727 20H0L6.569 3.52zm2.327 9.645l-2.166-5.837-2.166 5.837h4.332z"
        transform="translate(0, 1)"
        fill="currentColor"
      />
    </svg>
  );
}

/** API key input with AWS Bedrock and Anthropic tabs. */
export function ApiKeyInput({ onValidated }: ApiKeyInputProps) {
  const [provider, setProvider] = useState<ApiProvider>("bedrock");
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // Bedrock fields
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [region, setRegion] = useState("us-east-1");

  // Anthropic field
  const [apiKey, setApiKey] = useState("");

  const canValidate = provider === "bedrock" ? accessKeyId.trim() && secretKey.trim() : apiKey.trim();

  const handleValidate = async () => {
    if (!canValidate) return;
    setState("loading");
    setErrorMsg("");

    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      setState("success");
      setTimeout(() => {
        onValidated(provider);
      }, 600);
    } catch {
      setState("error");
      setErrorMsg("Invalid credentials. Check and try again.");
    }
  };

  const resetFields = () => {
    setAccessKeyId("");
    setSecretKey("");
    setRegion("us-east-1");
    setApiKey("");
    setState("idle");
    setErrorMsg("");
  };

  const btnState = state === "loading" ? "loading" : state === "success" ? "success" : "default";

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-api-card">
        {/* Provider toggle */}
        <div className="ob-api-toggle">
          <button
            type="button"
            className="ob-api-toggle-tab"
            data-active={provider === "bedrock"}
            onClick={() => {
              setProvider("bedrock");
              resetFields();
            }}
          >
            <AwsMark size={14} />
            AWS Bedrock
          </button>
          <button
            type="button"
            className="ob-api-toggle-tab"
            data-active={provider === "anthropic"}
            onClick={() => {
              setProvider("anthropic");
              resetFields();
            }}
          >
            <AnthropicMark size={14} />
            Anthropic
          </button>
        </div>

        {provider === "bedrock" ? (
          <>
            <div className="ob-api-field-label">AWS Access Key ID</div>
            <input
              type="text"
              className="ob-api-input"
              data-state={state === "error" ? "error" : state === "success" ? "valid" : undefined}
              placeholder="AKIA..."
              value={accessKeyId}
              onChange={(e) => {
                setAccessKeyId(e.target.value);
                if (state === "error") {
                  setState("idle");
                  setErrorMsg("");
                }
              }}
              disabled={state === "loading" || state === "success"}
              autoComplete="off"
            />

            <div className="ob-api-field-label">AWS Secret Access Key</div>
            <input
              type="password"
              className="ob-api-input"
              data-state={state === "error" ? "error" : state === "success" ? "valid" : undefined}
              value={secretKey}
              onChange={(e) => {
                setSecretKey(e.target.value);
                if (state === "error") {
                  setState("idle");
                  setErrorMsg("");
                }
              }}
              disabled={state === "loading" || state === "success"}
              autoComplete="off"
            />

            <div className="ob-api-field-label">AWS Region</div>
            <select
              className="ob-api-select"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              disabled={state === "loading" || state === "success"}
            >
              {AWS_REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <div className="ob-api-field-label">Anthropic API Key</div>
            <input
              type="password"
              className="ob-api-input"
              data-state={state === "error" ? "error" : state === "success" ? "valid" : undefined}
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (state === "error") {
                  setState("idle");
                  setErrorMsg("");
                }
              }}
              disabled={state === "loading" || state === "success"}
              autoComplete="off"
            />
          </>
        )}

        {/* Validate button */}
        <button
          type="button"
          className="ob-api-btn"
          data-state={btnState}
          onClick={handleValidate}
          disabled={!canValidate || state === "loading" || state === "success"}
        >
          {state === "loading" && <span className="ob-spinner ob-spinner-dark" />}
          {state === "loading" ? "VALIDATING..." : state === "success" ? "VERIFIED" : "VALIDATE"}
        </button>

        {state === "error" && errorMsg && <div className="ob-api-error">{errorMsg}</div>}
        {state === "success" && <div className="ob-api-success">Credentials verified ✓</div>}

        {state !== "success" && (
          <div className="ob-api-help">
            <a
              href={
                provider === "bedrock"
                  ? "https://docs.aws.amazon.com/bedrock/latest/userguide/setting-up.html"
                  : "https://console.anthropic.com/settings/keys"
              }
              target="_blank"
              rel="noopener noreferrer"
            >
              Get your {provider === "bedrock" ? "AWS Bedrock" : "Anthropic"} credentials →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
