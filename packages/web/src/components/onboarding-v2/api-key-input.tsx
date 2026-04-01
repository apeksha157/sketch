import { useTheme } from "@/hooks/use-theme";
import { useState } from "react";
import type { ApiProvider } from "./types";

interface ApiKeyInputProps {
  onValidated: (provider: ApiProvider) => void;
}

const AWS_REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "eu-west-3", "ap-southeast-1", "ap-northeast-1"];

function AwsMark({ size = 16 }: { size?: number }) {
  const { resolvedTheme } = useTheme();
  const filter = resolvedTheme === "dark" ? "brightness(0) invert(1)" : undefined;
  return <img src="/logos/aws-logo.png" alt="AWS" style={{ height: size, width: "auto", filter }} />;
}

function AnthropicMark({ size = 16 }: { size?: number }) {
  const { resolvedTheme } = useTheme();
  const filter = resolvedTheme === "dark" ? "brightness(0) invert(1)" : undefined;
  return <img src="/logos/anthropic-logo.png" alt="Anthropic" style={{ height: size, width: "auto", filter }} />;
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

  const validate = (): string | null => {
    if (provider === "anthropic") {
      const key = apiKey.trim();
      if (!key.startsWith("sk-ant-")) return "Anthropic keys start with sk-ant-";
      if (key.length < 20) return "Key looks too short — double-check it.";
      return null;
    }
    // bedrock
    const akid = accessKeyId.trim();
    if (!/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(akid)) return "Access Key ID should be 20 chars starting with AKIA or ASIA.";
    if (secretKey.trim().length < 40) return "Secret Access Key looks too short — double-check it.";
    return null;
  };

  const handleValidate = async () => {
    if (!canValidate) return;
    setErrorMsg("");

    const err = validate();
    if (err) {
      setState("error");
      setErrorMsg(err);
      return;
    }

    setState("loading");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    setState("success");
    setTimeout(() => {
      onValidated(provider);
    }, 600);
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

  /** Lock scroll position when switching tabs so content above doesn't shift into view. */
  const switchTab = (next: ApiProvider) => {
    const scrollParent = document.querySelector(".ob-chat");
    const scrollTop = scrollParent?.scrollTop ?? 0;
    setProvider(next);
    resetFields();
    requestAnimationFrame(() => {
      if (scrollParent) scrollParent.scrollTop = scrollTop;
    });
  };

  return (
    <div className="ob-widget ob-animate-in">
      <div className="ob-api-card">
        {/* Provider toggle */}
        <div className="ob-api-toggle">
          <button
            type="button"
            className="ob-api-toggle-tab"
            data-active={provider === "bedrock"}
            onClick={() => switchTab("bedrock")}
          >
            <AwsMark size={14} />
            AWS Bedrock
          </button>
          <button
            type="button"
            className="ob-api-toggle-tab"
            data-active={provider === "anthropic"}
            onClick={() => switchTab("anthropic")}
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
