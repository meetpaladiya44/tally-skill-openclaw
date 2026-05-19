OpenAI — Codex / ChatGPT Subscription OAuth
OpenClaw supports a full PKCE OAuth flow against https://auth.openai.com/oauth/authorize. Tokens are stored as an openai-codex:* profile in auth-profiles.json. The model ref to use is openai/gpt-5.5 (not the legacy openai-codex/* prefix).

openclaw models auth login --provider openai-codex  
# or for headless/VPS:  
openclaw models auth login --provider openai-codex --device-code
oauth.md:121-134 provider-openai-codex-oauth.ts:145-229

When the Codex subscription hits a usage limit, OpenClaw records the reset time and automatically rotates to the next ordered auth profile (e.g., an API-key backup), then switches back once the reset window passes. model-failover.md:129-157 command-account.ts:79-96

### OpenAI Codex (ChatGPT OAuth)
 
OpenAI Codex OAuth is explicitly supported for use outside the Codex CLI, including OpenClaw workflows.
 
Flow shape (PKCE):
 
1. generate PKCE verifier/challenge + random `state`
2. open `https://auth.openai.com/oauth/authorize?...`
3. try to capture callback on `http://127.0.0.1:1455/auth/callback`
4. if callback can't bind (or you're remote/headless), paste the redirect URL/code
5. exchange at `https://auth.openai.com/oauth/token`
6. extract `accountId` from the access token and store `{ access, refresh, expires, accountId }`
 
Wizard path is `openclaw onboard` → auth choice `openai-codex`.

export async function loginOpenAICodexOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;
 
  ensureGlobalUndiciEnvProxyDispatcher();
 
  const preflight = await runOpenAIOAuthTlsPreflight();
  if (!preflight.ok && preflight.kind === "tls-cert") {
    const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
    await prompter.note(hint, "OAuth prerequisites");
    runtime.error(hint);
    throw new Error(`OpenAI Codex OAuth prerequisites failed: ${preflight.message}`);
  }
 
  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "Open it, sign in, then paste the redirect URL here.",
          "If this OpenClaw process can receive the browser callback, sign-in may finish automatically before you paste.",
        ].join("\n")
      : [
          "Browser will open for OpenAI authentication.",
          "If the callback doesn't auto-complete, paste the redirect URL.",
          "OpenAI OAuth uses localhost:1455 for the callback.",
        ].join("\n"),
    "OpenAI Codex OAuth",
  );
 
  const spin = prompter.progress("Starting OAuth flow…");
  let progressActive = true;
  const updateProgress = (message: string) => {
    if (progressActive) {
      spin.update(message);
    }
  };
  const stopProgress = (message?: string) => {
    if (progressActive) {
      progressActive = false;
      spin.stop(message);
    }
  };
  let browserAuthStarted = false;
  let markLoginSettled!: () => void;
  const waitForLoginToSettle = new Promise<void>((resolve) => {
    markLoginSettled = resolve;
  });
  try {
    const { onAuth: baseOnAuth, onPrompt } = createVpsAwareOAuthHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…",
      manualPromptMessage: manualInputPromptMessage,
    });
    const onAuth: typeof baseOnAuth = async (event) => {
      browserAuthStarted = true;
      await baseOnAuth(event);
    };
 
    const creds = await loginOpenAICodex({
      onAuth,
      onPrompt,
      originator: openAICodexOAuthOriginator,
      onManualCodeInput: createManualCodeInputHandler({
        isRemote,
        onPrompt,
        runtime,
        updateProgress,
        stopProgress,
        waitForLoginToSettle,
        hasBrowserAuthStarted: () => browserAuthStarted,
      }),
      onProgress: (msg: string) => updateProgress(msg),
    });
    stopProgress("OpenAI OAuth complete");
    return creds ?? null;


    ### OpenAI Codex subscription plus API-key backup
 
For OpenAI agent models, auth and runtime are separate. `openai/gpt-*` stays on
the Codex harness while auth can rotate between a Codex subscription profile and
an OpenAI API-key backup.
 
Use `auth.order.openai` for the user-facing order:
 
```json5
{
  auth: {
    order: {
      openai: ["openai-codex:user@example.com", "openai:api-key-backup"],
    },
  },
}
```
 
Existing Codex subscription profiles may still use the legacy
`openai-codex:*` profile id. The ordered API-key backup can be a normal
`openai:*` API-key profile. When the subscription hits a Codex usage limit,
OpenClaw records the exact reset time when Codex provides one, tries the next
ordered auth profile, and keeps the run inside the Codex harness. Once the reset
time passes, the subscription profile is eligible again and the next automatic
selection can return to it.
 
Use a user-pinned profile only when you want to force one account/key for that
session. User-pinned profiles are intentionally strict and do not silently jump
to another profile.

const subscriptionProfileId = order.find((profileId) =>
    isChatGptSubscriptionProfile(store.profiles[profileId]),
  );
  const activeIsSubscription =
    activeProfileId !== undefined && isChatGptSubscriptionProfile(store.profiles[activeProfileId]);
  const activeUsage =
    activeIsSubscription && params.limits.ok
      ? summarizeCodexAccountUsage(params.limits.value, now)
      : undefined;
  const subscriptionUsage =
    subscriptionProfileId && (!activeIsSubscription || subscriptionProfileId !== activeProfileId)
      ? await readSubscriptionUsage({
          ...params,
          config,
          subscriptionProfileId,
          now,
        })
      : activeUsage;

How OpenAI Subscription Works in OpenClaw
Step 1: OAuth Login (PKCE flow)
Login is handled by loginOpenAICodexOAuth in src/plugins/provider-openai-codex-oauth.ts, which delegates to loginOpenAICodex from the closed-source @earendil-works/pi-ai/oauth package. The flow:

Generate PKCE verifier/challenge + random state
Open https://auth.openai.com/oauth/authorize?...
Capture callback on http://127.0.0.1:1455/auth/callback (or paste redirect URL for headless)
Exchange code at https://auth.openai.com/oauth/token
Extract accountId from the JWT access token
Store { access, refresh, expires, accountId } as an openai-codex:* profile in auth-profiles.json oauth.md:121-134 provider-openai-codex-oauth.ts:213-229
Step 2: Token Refresh
At runtime, if expires is past, refreshOpenAICodexToken (also from @earendil-works/pi-ai/oauth) is called with the stored refresh token. It handles refresh_token_reused errors by re-reading the on-disk profile (another process may have already refreshed it). The refreshed { access, refresh, expires } is written back under a file lock. openai-codex-provider.ts:342-370 openai-codex-provider.runtime.ts:1-45

Step 3: Execution — Two Paths
Default path (Codex app-server harness): The access token is NOT used as a direct HTTP Bearer token. Instead, applyCodexAppServerAuthProfile sends it to the Codex app-server binary via a JSON-RPC call:

account/login/start { type: "chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType }  
The Codex app-server (a bundled binary, codex app-server --listen stdio://) then owns the actual model execution loop. OpenClaw communicates with it over stdio or WebSocket JSON-RPC. auth-bridge.ts:295-325 auth-bridge.test.ts:538-568

Legacy/explicit PI path: When agentRuntime.id: "pi" is explicitly set, the access token is used as a Bearer token directly against https://chatgpt.com/backend-api/codex (the openai-codex-responses API). This is a private ChatGPT backend endpoint, not the public api.openai.com. base-url.ts:1-23 openai-transport-stream.ts:1239-1270

Can You Extract This to Build Your Own API?
No, not practically. Here's why:

The OAuth client details are opaque. The PKCE client ID, scopes, and token exchange logic live entirely inside @earendil-works/pi-ai/oauth, which is a closed-source npm package. OpenClaw doesn't expose these parameters. provider-openai-codex-oauth.ts:1-15

The access token targets a private endpoint. The subscription token works against https://chatgpt.com/backend-api/codex, not https://api.openai.com. This is an internal ChatGPT backend, not a documented public API. Using it outside of sanctioned clients would likely violate OpenAI's ToS. base-url.ts:3

The default execution path requires the Codex app-server binary. The token is passed to a proprietary binary via RPC — it's not a simple HTTP Bearer token you can reuse in arbitrary requests. codex-harness-reference.md:50-63

OpenAI's explicit sanction is scoped. The docs note OpenAI "explicitly supports subscription OAuth usage in external tools and workflows like OpenClaw" — but this refers to the Codex app-server harness integration, not general-purpose API access with the subscription token. openai.md:27

If you want programmatic access to OpenAI models, the correct path is an OPENAI_API_KEY from platform.openai.com, not the subscription OAuth token.