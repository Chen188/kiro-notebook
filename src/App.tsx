import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import PdfViewer from "./PdfViewer";
import {
  FileText, FileType, FileCode, Globe, Paperclip, FolderOpen,
  RefreshCw, Plus, Minus, ClipboardList, X, ChevronRight, ChevronDown,
  ArrowUp, Square, MessageSquare, Check, Quote, ShieldCheck,
  ExternalLink, Copy, Loader2,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  extension: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatSession {
  id: string;
  label: string;
  messages: ChatMessage[];
  contextFiles?: string[];
  sentContextFiles?: string[];
}

interface ToolActivity {
  toolCallId: string;
  title: string;
  kind: string;
  detail: string;
  status: string;
  hadPermission: boolean;
}

const MODELS = [
  { id: "auto", label: "Auto", credits: "1.00x" },
  { id: "claude-sonnet-4.6", label: "Sonnet 4.6", credits: "1.30x" },
  { id: "claude-opus-4.6", label: "Opus 4.6", credits: "2.20x" },
  { id: "claude-sonnet-4.5", label: "Sonnet 4.5", credits: "1.30x" },
  { id: "claude-opus-4.5", label: "Opus 4.5", credits: "2.20x" },
  { id: "claude-sonnet-4", label: "Sonnet 4", credits: "1.30x" },
  { id: "claude-haiku-4.5", label: "Haiku 4.5", credits: "0.40x" },
];

const FILE_ICONS: Record<string, React.ReactNode> = {
  pdf: <FileText size={14} className="icon-pdf" />,
  docx: <FileType size={14} className="icon-docx" />,
  md: <FileCode size={14} className="icon-md" />,
  txt: <FileText size={14} className="icon-txt" />,
  html: <Globe size={14} className="icon-html" />,
};

function getFileIcon(ext: string): React.ReactNode {
  return FILE_ICONS[ext] || <FileText size={14} />;
}

export default function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [contextFiles, setContextFiles] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [toolActivitiesMap, setToolActivitiesMap] = useState<Record<number, ToolActivity[]>>({});
  const [toolExpanded, setToolExpanded] = useState(false);
  const currentToolMsgIdxRef = useRef<number>(-1);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [previewWidth, setPreviewWidth] = useState(50);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<ChatSession[]>([]);
  const [selectedModel, setSelectedModel] = useState("auto");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const streamingRef = useRef("");
  const draggingRef = useRef(false);
  const panelsRef = useRef<HTMLDivElement>(null);
  const sentContextRef = useRef<Set<string>>(new Set());
  const currentSessionRef = useRef<string | null>(null);
  const htmlIframeRef = useRef<HTMLIFrameElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const [selectedText, setSelectedText] = useState("");
  const [selectionPosition, setSelectionPosition] = useState<{ x: number; y: number } | null>(null);

  // Keep ref in sync
  useEffect(() => { currentSessionRef.current = currentSessionId; }, [currentSessionId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, toolActivitiesMap]);

  // Load recent workspaces from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("kiro-notebook-recent-workspaces");
      if (saved) setRecentWorkspaces(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (currentSessionId && messages.length > 0) {
      const curCtx = Array.from(contextFiles);
      const curSent = Array.from(sentContextRef.current);
      setSessions((prev) =>
        prev.map((s) => s.id === currentSessionId ? { ...s, messages, contextFiles: curCtx, sentContextFiles: curSent } : s),
      );
      const session = sessions.find((s) => s.id === currentSessionId);
      invoke("save_session_history", {
        sessionId: currentSessionId,
        label: session?.label || currentSessionId,
        messages: JSON.stringify(messages),
        contextFiles: curSent,
      }).catch(() => {});
    }
  }, [messages, currentSessionId, contextFiles]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !panelsRef.current) return;
      const rect = panelsRef.current.getBoundingClientRect();
      const pct = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
      setPreviewWidth(pct);
    };
    const onMouseUp = () => { draggingRef.current = false; };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  }, []);


  // Selection detection for Quote in Chat
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      // Check main document selection (PDF/MD/TXT)
      let text = window.getSelection()?.toString().trim() || "";

      // Check HTML iframe selection if no main selection
      if (!text && htmlIframeRef.current?.contentWindow) {
        try {
          text = htmlIframeRef.current.contentWindow.getSelection()?.toString().trim() || "";
        } catch {
          // cross-origin fallback — ignore
        }
      }

      if (text) {
        setSelectedText(text);
        setSelectionPosition({ x: e.clientX, y: e.clientY });
      } else {
        setSelectedText("");
        setSelectionPosition(null);
      }
    };

    const previewEl = document.querySelector(".preview-content");
    previewEl?.addEventListener("mouseup", handleMouseUp as EventListener);

    // Attach listener inside HTML iframe when it loads
    const iframe = htmlIframeRef.current;
    const attachIframeListener = () => {
      try {
        const doc = iframe?.contentDocument;
        if (doc) {
          doc.addEventListener("mouseup", ((e: Event) => {
            const me = e as MouseEvent;
            let text = "";
            try {
              text = iframe?.contentWindow?.getSelection()?.toString().trim() || "";
            } catch { /* ignore */ }
            if (text) {
              // Map iframe coords to parent viewport
              const rect = iframe!.getBoundingClientRect();
              setSelectedText(text);
              setSelectionPosition({ x: rect.left + me.clientX, y: rect.top + me.clientY });
            } else {
              setSelectedText("");
              setSelectionPosition(null);
            }
          }) as EventListener);
        }
      } catch { /* cross-origin fallback */ }
    };
    iframe?.addEventListener("load", attachIframeListener);

    // Clear selection when clicking outside preview
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".preview-content") && !target.closest(".quote-button")) {
        setSelectedText("");
        setSelectionPosition(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      previewEl?.removeEventListener("mouseup", handleMouseUp as EventListener);
      iframe?.removeEventListener("load", attachIframeListener);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [selectedFile]);

  const quoteInChat = useCallback(() => {
    const quoted = selectedText
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    setInput((prev) => (prev ? prev + "\n\n" + quoted + "\n\n" : quoted + "\n\n"));
    setSelectedText("");
    setSelectionPosition(null);
    // Focus the chat textarea
    setTimeout(() => chatInputRef.current?.focus(), 0);
  }, [selectedText]);

  const saveWorkspaceHistory = useCallback((path: string) => {
    try {
      const saved = localStorage.getItem("kiro-notebook-recent-workspaces");
      let history: string[] = saved ? JSON.parse(saved) : [];
      history = [path, ...history.filter((p) => p !== path)].slice(0, 10);
      localStorage.setItem("kiro-notebook-recent-workspaces", JSON.stringify(history));
      setRecentWorkspaces(history);
    } catch { /* ignore */ }
  }, []);

  const initWorkspace = useCallback(async (path: string) => {
    const canonical = await invoke<string>("select_workspace", { path });
    setWorkspace(canonical);
    saveWorkspaceHistory(canonical);
    setSelectedFile(null);
    setFileContent("");
    setContextFiles(new Set());
    setMessages([]);
    setToolActivitiesMap({});
    currentToolMsgIdxRef.current = -1;
    setFiles(await invoke<FileEntry[]>("list_files"));
  }, [saveWorkspaceHistory]);

  const openWorkspace = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) await initWorkspace(selected as string);
  }, [initWorkspace]);

  const openRecentWorkspace = useCallback(async (path: string) => {
    try {
      await initWorkspace(path);
    } catch {
      // Path no longer exists — remove from history
      try {
        const saved = localStorage.getItem("kiro-notebook-recent-workspaces");
        let history: string[] = saved ? JSON.parse(saved) : [];
        history = history.filter((p) => p !== path);
        localStorage.setItem("kiro-notebook-recent-workspaces", JSON.stringify(history));
        setRecentWorkspaces(history);
      } catch { /* ignore */ }
    }
  }, [initWorkspace]);

  const refreshFiles = useCallback(async () => {
    setFiles(await invoke<FileEntry[]>("list_files"));
  }, []);

  const selectFile = useCallback(async (file: FileEntry) => {
    setSelectedFile(file);
    setZoomLevel(1);
    getCurrentWebview().setZoom(1);
    setContextFiles((prev) => new Set(prev).add(file.path));
    if (file.extension === "pdf") {
      setFileContent("");
      return;
    }
    try {
      setFileContent(await invoke<string>("read_file_content", { path: file.path }));
    } catch (e) {
      setFileContent(`Error reading file: ${e}`);
    }
  }, []);

  const toggleContext = useCallback((path: string) => {
    setContextFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        if (sentContextRef.current.has(path)) return prev;
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const changeModel = useCallback(async (modelId: string) => {
    setSelectedModel(modelId);
    const sid = currentSessionRef.current;
    if (sid) {
      try {
        await invoke("set_model", { sessionId: sid, modelId });
      } catch (e) {
        console.error("Failed to set model", e);
      }
    }
  }, []);

  const runPrompt = useCallback(
    async (sessionId: string, message: string, ctx: string[]) => {
      streamingRef.current = "";
      setMessages((prev) => {
        currentToolMsgIdxRef.current = prev.length;
        return [...prev, { role: "assistant", content: "" }];
      });
      setLoading(true);
      setToolExpanded(false);

      const unlisten1 = await listen<{ sessionId: string; text: string }>("acp-chunk", (e) => {
        if (e.payload.sessionId !== sessionId) return;
        streamingRef.current += e.payload.text;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: streamingRef.current };
          return updated;
        });
      });

      const unlisten2 = await listen<{ sessionId: string; type: string; title?: string; status?: string; kind?: string; detail?: string; option?: string; toolCallId?: string }>("acp-status", (e) => {
        if (e.payload.sessionId !== sessionId) return;
        const idx = currentToolMsgIdxRef.current;
        if (idx < 0) return;

        if (e.payload.type === "tool_call") {
          const tcId = e.payload.toolCallId || "";
          setToolActivitiesMap((prev) => {
            const activities = [...(prev[idx] || [])];
            // Check if this toolCallId already exists (second update with rawInput)
            const existingIdx = tcId ? activities.findIndex((a) => a.toolCallId === tcId) : -1;
            if (existingIdx >= 0) {
              // Update existing entry with new title/detail
              activities[existingIdx] = {
                ...activities[existingIdx],
                title: e.payload.title || activities[existingIdx].title,
                detail: e.payload.detail || activities[existingIdx].detail,
                kind: e.payload.kind || activities[existingIdx].kind,
              };
              return { ...prev, [idx]: activities };
            }
            // New tool: mark all previous non-completed as completed (fixes spinning icon bug)
            const marked = activities.map((a) => a.status !== "completed" ? { ...a, status: "completed" } : a);
            marked.push({
              toolCallId: tcId,
              title: e.payload.title || "Working...",
              kind: e.payload.kind || "",
              detail: e.payload.detail || "",
              status: "running",
              hadPermission: false,
            });
            return { ...prev, [idx]: marked };
          });
        } else if (e.payload.type === "tool_update") {
          setToolActivitiesMap((prev) => {
            const activities = [...(prev[idx] || [])];
            if (activities.length === 0) return prev;
            for (let j = activities.length - 1; j >= 0; j--) {
              if (activities[j].status !== "completed") {
                activities[j] = { ...activities[j], status: e.payload.status || activities[j].status };
                break;
              }
            }
            return { ...prev, [idx]: activities };
          });
        } else if (e.payload.type === "permission") {
          setToolActivitiesMap((prev) => {
            const activities = [...(prev[idx] || [])];
            if (activities.length === 0) return prev;
            for (let j = activities.length - 1; j >= 0; j--) {
              if (activities[j].status !== "completed") {
                activities[j] = { ...activities[j], detail: e.payload.detail || activities[j].detail, hadPermission: true };
                return { ...prev, [idx]: activities };
              }
            }
            return prev;
          });
        }
      });

      try {
        await invoke<string>("send_prompt", { sessionId, message, contextFiles: ctx });
      } catch (e) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: streamingRef.current || `❌ Error: ${e}` };
          return updated;
        });
      }

      unlisten1();
      unlisten2();
      setLoading(false);
      // Mark all remaining activities as completed when prompt finishes
      const finalIdx = currentToolMsgIdxRef.current;
      if (finalIdx >= 0) {
        setToolActivitiesMap((prev) => {
          const activities = prev[finalIdx];
          if (!activities) return prev;
          const completed = activities.map((a) => a.status !== "completed" ? { ...a, status: "completed" } : a);
          return { ...prev, [finalIdx]: completed };
        });
      }
    },
    [],
  );

  const cancelPrompt = useCallback(async () => {
    const sid = currentSessionRef.current;
    if (!sid) return;
    try {
      await invoke("cancel_prompt", { sessionId: sid });
    } catch (e) {
      console.error("Failed to cancel", e);
    }
  }, []);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (currentSessionRef.current) return currentSessionRef.current;
    try {
      const sessionId = await invoke<string>("new_acp_session");
      setCurrentSessionId(sessionId);
      const label = `${new Date().toLocaleString()} · ${sessionId.slice(0, 8)}`;
      const ctx = Array.from(contextFiles);
      setSessions((prev) => [...prev, { id: sessionId, label, messages: [], contextFiles: ctx }]);
      sentContextRef.current = new Set();
      if (selectedModel !== "auto") {
        await invoke("set_model", { sessionId, modelId: selectedModel }).catch(() => {});
      }
      return sessionId;
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: `❌ Failed to create session: ${e}` }]);
      return null;
    }
  }, [selectedModel, contextFiles]);

  const newSession = useCallback(async () => {
    if (loading) return;
    const curCtx = Array.from(contextFiles);
    const curSent = Array.from(sentContextRef.current);
    setSessions((prev) => prev.map((s) => s.id === currentSessionRef.current ? { ...s, messages, contextFiles: curCtx, sentContextFiles: curSent } : s));
    try {
      const sessionId = await invoke<string>("new_acp_session");
      setCurrentSessionId(sessionId);
      const label = `${new Date().toLocaleString()} · ${sessionId.slice(0, 8)}`;
      setSessions((prev) => [...prev, { id: sessionId, label, messages: [], contextFiles: curCtx }]);
      setMessages([]);
      setToolActivitiesMap({});
      currentToolMsgIdxRef.current = -1;
      sentContextRef.current = new Set();
      if (selectedModel !== "auto") {
        await invoke("set_model", { sessionId, modelId: selectedModel }).catch(() => {});
      }
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: `❌ Failed to create session: ${e}` }]);
    }
  }, [loading, messages, selectedModel, contextFiles]);

  const switchSession = useCallback(
    (sessionId: string) => {
      if (sessionId === currentSessionRef.current || loading) return;
      const curCtx = Array.from(contextFiles);
      const curSent = Array.from(sentContextRef.current);
      setSessions((prev) => prev.map((s) => s.id === currentSessionRef.current ? { ...s, messages, contextFiles: curCtx, sentContextFiles: curSent } : s));
      const target = sessions.find((s) => s.id === sessionId);
      if (target) {
        setCurrentSessionId(sessionId);
        setMessages(target.messages);
        setToolActivitiesMap({});
        currentToolMsgIdxRef.current = -1;
        setContextFiles(new Set(target.contextFiles || []));
        sentContextRef.current = new Set(target.sentContextFiles || []);
      }
    },
    [messages, sessions, loading, contextFiles],
  );

  const closeSession = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      invoke("close_acp_session", { sessionId }).catch(() => {});
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      if (sessionId === currentSessionRef.current) {
        if (remaining.length > 0) {
          const last = remaining[remaining.length - 1];
          setCurrentSessionId(last.id);
          setMessages(last.messages);
          setToolActivitiesMap({});
          currentToolMsgIdxRef.current = -1;
          setContextFiles(new Set(last.contextFiles || []));
          sentContextRef.current = new Set(last.sentContextFiles || []);
        } else {
          setCurrentSessionId(null);
          setMessages([]);
          setToolActivitiesMap({});
          currentToolMsgIdxRef.current = -1;
          setContextFiles(new Set());
          sentContextRef.current = new Set();
        }
      }
    },
    [sessions],
  );

  const loadHistory = useCallback(async () => {
    try {
      const data = await invoke<string>("load_session_history");
      const list = JSON.parse(data) as Array<{ sessionId: string; label: string; messages: ChatMessage[]; contextFiles?: string[]; updatedAt: string }>;
      setHistoryList(list.map((h) => ({
        id: h.sessionId,
        label: h.updatedAt ? `${new Date(h.updatedAt).toLocaleString()} · ${h.sessionId.slice(0, 8)}` : h.label,
        messages: h.messages,
        contextFiles: h.contextFiles,
        sentContextFiles: h.contextFiles,
      })));
      setShowHistory(true);
    } catch (e) {
      console.error("Failed to load history", e);
    }
  }, []);

  const loadHistorySession = useCallback(
    async (session: ChatSession) => {
      try {
        const newId = await invoke<string>("load_acp_session", { sessionId: session.id });
        const loaded = { ...session, id: newId };
        setCurrentSessionId(newId);
        setMessages(session.messages);
        setToolActivitiesMap({});
        currentToolMsgIdxRef.current = -1;
        if (session.contextFiles?.length) {
          setContextFiles(new Set(session.contextFiles));
        }
        // If same session ID, ACP restored context — mark sent files as sent
        // If new ID (fallback), nothing has been sent yet
        sentContextRef.current = newId === session.id
          ? new Set(session.sentContextFiles || [])
          : new Set();
        if (!sessions.find((s) => s.id === newId)) {
          setSessions((prev) => [...prev, loaded]);
        }
        setShowHistory(false);
      } catch (e) {
        setMessages((prev) => [...prev, { role: "assistant", content: `❌ Failed to load session: ${e}` }]);
      }
    },
    [sessions],
  );

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);

    const sessionId = await ensureSession();
    if (!sessionId) return;

    const unsent = Array.from(contextFiles).filter((f) => !sentContextRef.current.has(f));
    unsent.forEach((f) => sentContextRef.current.add(f));
    await runPrompt(sessionId, userMsg, unsent);
  }, [input, loading, contextFiles, runPrompt, ensureSession]);

  if (!workspace) {
    return (
      <div className="welcome">
        <div className="welcome-content">
          <img src="/icon.png" alt="Kiro Notebook" className="welcome-icon" />
          <h1>Kiro Notebook</h1>
          <p>Your local AI-powered document assistant</p>
          <p className="subtitle">Powered by Kiro CLI via Agent Client Protocol</p>
          <button onClick={openWorkspace} className="btn-primary"><FolderOpen size={16} /> Open Workspace</button>
          {recentWorkspaces.length > 0 && (
            <div className="recent-workspaces">
              <h3>Recent</h3>
              {recentWorkspaces.map((p) => {
                const folderName = p.split("/").pop() || p;
                return (
                  <div key={p} className="recent-item" onClick={() => openRecentWorkspace(p)} title={p}>
                    <FolderOpen size={16} className="recent-item-icon" />
                    <div className="recent-item-text">
                      <span className="recent-item-name">{folderName}</span>
                      <span className="recent-item-path">{p}</span>
                    </div>
                    <button className="recent-item-remove" onClick={(e) => {
                      e.stopPropagation();
                      const updated = recentWorkspaces.filter((x) => x !== p);
                      localStorage.setItem("kiro-notebook-recent-workspaces", JSON.stringify(updated));
                      setRecentWorkspaces(updated);
                    }}><X size={12} /></button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="toolbar">
        <span className="app-title"><img src="/icon.png" alt="" className="app-logo" /> Kiro Notebook</span>
        <span className="workspace-path" title={workspace}>{workspace}</span>
        <select
          className="model-select"
          value={selectedModel}
          onChange={(e) => changeModel(e.target.value)}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label} ({m.credits})</option>
          ))}
        </select>
        <button onClick={openWorkspace} className="btn-small">Switch</button>
      </header>

      <div className="panels">
        <div className="panel file-panel">
          <div className="panel-header">
            Files
            <span className="badge">{files.length}</span>
            <button onClick={refreshFiles} className="btn-small" style={{ marginLeft: "auto" }}><RefreshCw size={12} /></button>
          </div>
          <div className="file-list">
            {files.map((file) => (
              <div key={file.path} className={`file-item ${selectedFile?.path === file.path ? "selected" : ""}`}>
                <label className="file-checkbox" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={contextFiles.has(file.path)} onChange={() => toggleContext(file.path)} />
                </label>
                <div className="file-info" onClick={() => selectFile(file)}>
                  <span className="file-icon">{getFileIcon(file.extension)}</span>
                  <span className="file-name" title={file.path}>{file.name}</span>
                </div>
              </div>
            ))}
            {files.length === 0 && <div className="empty-state">No supported files found</div>}
          </div>
          {contextFiles.size > 0 && (
            <div className="context-status"><Paperclip size={12} /> {contextFiles.size} file{contextFiles.size > 1 ? "s" : ""} as context</div>
          )}
        </div>

        <div className="main-panels" ref={panelsRef}>
          <div className="panel preview-panel" style={{ flex: `0 0 ${previewWidth}%` }}>
            <div className="panel-header">
              Preview
              {selectedFile && <span className="preview-filename">{selectedFile.name}</span>}
              <div className="zoom-controls">
                <button className="zoom-btn" onClick={() => { const z = Math.max(0.2, zoomLevel - 0.1); setZoomLevel(z); getCurrentWebview().setZoom(z); }} title="Zoom out"><Minus size={12} /></button>
                <button className="zoom-label" onClick={() => { setZoomLevel(1); getCurrentWebview().setZoom(1); }} title="Reset zoom">{Math.round(zoomLevel * 100)}%</button>
                <button className="zoom-btn" onClick={() => { const z = Math.min(5, zoomLevel + 0.1); setZoomLevel(z); getCurrentWebview().setZoom(z); }} title="Zoom in"><Plus size={12} /></button>
              </div>
            </div>
            <div className="preview-content">
              {selectedFile ? (
                selectedFile.extension === "pdf" ? (
                  <PdfViewer url={convertFileSrc(selectedFile.path)} />
                ) : selectedFile.extension === "html" ? (
                  <iframe ref={htmlIframeRef} srcDoc={fileContent} sandbox="allow-same-origin" className="preview-iframe" />
                ) : selectedFile.extension === "md" || selectedFile.extension === "docx" ? (
                  <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent}</ReactMarkdown></div>
                ) : (
                  <pre className="text-content">{fileContent}</pre>
                )
              ) : (
                <div className="empty-state">Select a file to preview its content</div>
              )}
              {selectedText && selectionPosition && (
                <button
                  className="quote-button"
                  style={{ position: "fixed", left: selectionPosition.x, top: selectionPosition.y + 10 }}
                  onClick={quoteInChat}
                >
                  <Quote size={14} /> Quote in Chat
                </button>
              )}
            </div>
          </div>

          <div className="drag-handle" onMouseDown={() => { draggingRef.current = true; }} />

          <div className="panel chat-panel" style={{ flex: `0 0 ${100 - previewWidth}%` }}>
            <div className="panel-header">
                <MessageSquare size={14} /> AI Chat
              {currentSessionId && <span className="status-dot online" />}
              <button onClick={newSession} className="btn-small" disabled={loading} style={{ marginLeft: "auto" }}><Plus size={12} /> New</button>
              <button onClick={loadHistory} className="btn-small"><ClipboardList size={12} /></button>
            </div>
            {sessions.length > 0 && (
              <div className="session-tabs">
                {sessions.map((s) => (
                  <div key={s.id} className={`session-tab ${s.id === currentSessionId ? "active" : ""}`} onClick={() => switchSession(s.id)} title={s.id}>
                    <span className="session-tab-label">{s.label}</span>
                    <span className="session-tab-close" onClick={(e) => closeSession(s.id, e)}><X size={10} /></span>
                  </div>
                ))}
              </div>
            )}
            {contextFiles.size > 0 && (
              <div className="context-list">
                <div className="context-list-header" onClick={() => setContextCollapsed(!contextCollapsed)}>
                  <span>{contextCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />} Context ({contextFiles.size})</span>
                </div>
                {!contextCollapsed && (
                  <div className="context-list-items">
                    {Array.from(contextFiles).map((f) => {
                      const name = f.split("/").pop() || f;
                      const sent = sentContextRef.current.has(f);
                      return (
                        <div key={f} className={`context-list-item ${sent ? "sent" : ""}`}>
                          <span className="file-icon">{getFileIcon(name.split(".").pop() || "")}</span>
                          <span className="context-item-name" title={f}>{name}</span>
                          {sent
                            ? <Check size={12} className="context-sent-icon" />
                            : <button className="context-remove" onClick={() => toggleContext(f)}><X size={10} /></button>
                          }
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {showHistory && (
              <div className="history-panel">
                <div className="history-header">
                  <span>Chat History</span>
                  <button className="btn-small" onClick={() => setShowHistory(false)}><X size={12} /></button>
                </div>
                <div className="history-list">
                  {historyList.length === 0 && <div className="empty-state">No saved sessions</div>}
                  {historyList.map((h) => (
                    <div key={h.id} className={`history-item ${h.id === currentSessionId ? "active" : ""}`} onClick={() => loadHistorySession(h)}>
                      <div className="history-item-label">{h.label}</div>
                      <div className="history-item-preview">
                        {h.messages.filter((m) => m.role === "user")[0]?.content.slice(0, 60) || "No messages"}
                      </div>
                      {h.contextFiles && h.contextFiles.length > 0 && (
                        <div className="history-item-files">
                          {h.contextFiles.map((f) => {
                            const name = f.split("/").pop() || f;
                            return (
                              <span key={f} className="history-file-chip">
                                <span className="file-icon">{getFileIcon(name.split(".").pop() || "")}</span>
                                {name}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="chat-messages">
              {messages.map((msg, i) => {
                const activities = toolActivitiesMap[i] || [];
                const isStreaming = loading && i === messages.length - 1;
                const showTools = msg.role === "assistant" && activities.length > 0;
                return (
                  <div key={i}>
                    {showTools && (
                      <div className={`tool-panel ${isStreaming ? "active" : "done"}`}>
                        <div className="tool-panel-header" onClick={() => setToolExpanded((v) => !v)}>
                          {isStreaming ? (
                            <Loader2 size={13} className="tool-panel-icon spin" />
                          ) : (
                            <Check size={13} className="tool-panel-icon done" />
                          )}
                          <span className="tool-panel-title">
                            {(() => {
                              const active = activities.filter((a) => a.status !== "completed");
                              if (isStreaming && active.length > 0) {
                                return active[active.length - 1].title;
                              }
                              return `Used ${activities.length} tool${activities.length > 1 ? "s" : ""}`;
                            })()}
                          </span>
                          {activities.length > 1 && (
                            <span className="tool-panel-count">{activities.length}</span>
                          )}
                          {toolExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </div>
                        {toolExpanded && (
                          <div className="tool-panel-body">
                            {activities.map((a, j) => (
                              <div key={j} className={`tool-row ${a.status === "completed" ? "completed" : ""}`}>
                                {a.status === "completed" ? (
                                  <Check size={11} className="tool-row-icon done" />
                                ) : (
                                  <Loader2 size={11} className="tool-row-icon spin" />
                                )}
                                <span className="tool-row-title">{a.title}</span>
                                {a.hadPermission && <ShieldCheck size={10} className="tool-row-shield" />}
                                {a.detail && (
                                  <span className="tool-row-detail-group">
                                    <span className="tool-row-detail" title={a.detail}>{a.detail}</span>
                                    <button className="tool-row-btn" title="Copy" onClick={(ev) => { ev.stopPropagation(); navigator.clipboard.writeText(a.detail); }}><Copy size={10} /></button>
                                    {/^https?:\/\//.test(a.detail) && (
                                      <button className="tool-row-btn" title="Open" onClick={(ev) => { ev.stopPropagation(); openUrl(a.detail).catch(() => {}); }}><ExternalLink size={10} /></button>
                                    )}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {msg.role === "assistant" && isStreaming && !msg.content ? (
                      !showTools && (
                        <div className="message assistant">
                          <div className="message-bubble typing-indicator">
                            <span /><span /><span />
                          </div>
                        </div>
                      )
                    ) : (
                      <div className={`message ${msg.role}`}>
                        <div className="message-bubble">
                          {msg.role === "assistant" ? (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                          ) : msg.content}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={chatEndRef} />
            </div>
            <div className="chat-input-area">
              <textarea
                ref={chatInputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder="Ask about your documents..."
                disabled={loading}
                rows={2}
              />
              <button onClick={sendMessage} disabled={loading || !input.trim()} className="btn-send"><ArrowUp size={16} /></button>
              {loading && <button onClick={cancelPrompt} className="btn-cancel"><Square size={14} /></button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
