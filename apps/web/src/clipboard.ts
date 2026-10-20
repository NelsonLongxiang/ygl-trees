/**
 * Copy text for the user and say whether it really happened. The async
 * clipboard API needs a secure context (webui serve over plain http on a LAN
 * address has none), so the legacy execCommand path stays — and its boolean
 * result is honoured: a "copied" that didn't copy is worse than none.
 */
export interface CopyEnv {
  clipboard?: { writeText(text: string): Promise<void> } | null;
  /** legacy path; returns whether the copy took */
  exec?: (text: string) => boolean;
}

function browserEnv(): CopyEnv {
  return {
    clipboard: typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard : null,
    exec: (text) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        return document.execCommand("copy");
      } finally {
        ta.remove();
      }
    },
  };
}

export async function copyText(text: string, env?: CopyEnv): Promise<boolean> {
  const e = env ?? browserEnv();
  try {
    if (e.clipboard) {
      await e.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* denied or unavailable: fall through to the legacy path */
  }
  try {
    return e.exec ? e.exec(text) === true : false;
  } catch {
    return false;
  }
}
