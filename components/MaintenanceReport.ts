/**
 * Turns a recorded maintenance run (console transcript + any report files the
 * tool wrote, e.g. migration-report.md/json) into a single self-contained
 * HTML document. The same document is shown in the admin panel's report modal
 * and sent by email, so it only uses inline styles that email clients accept.
 */
import { promises as fs } from "fs";
import path from "path";
import type { MaintenanceRunRecord } from "./MaintenanceRunner";

export type MaintenanceReportArtifact = {
  filename: string;
  contentType: string;
  content: string;
};

export type MaintenanceReport = {
  subject: string;
  html: string;
  text: string;
  attachments: MaintenanceReportArtifact[];
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline markdown: bold, italics, inline code, links. Input is pre-escaped. */
function renderInlineMarkdown(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code style=\"background:#eef2ee;border-radius:4px;padding:1px 5px;font-family:monospace;\">$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<a href=\"$2\" style=\"color:#2f7a3b;\">$1</a>");
}

/**
 * Minimal markdown renderer covering what the maintenance tools emit:
 * headings, lists, tables, fenced code blocks, paragraphs. Not a general
 * markdown implementation — unknown constructs degrade to escaped text.
 */
export function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let listItems: string[] = [];
  let tableRows: string[][] = [];

  const flushList = () => {
    if (listItems.length > 0) {
      html.push(`<ul style="margin:8px 0 12px;padding-left:22px;">${listItems.join("")}</ul>`);
      listItems = [];
    }
  };
  const flushTable = () => {
    if (tableRows.length === 0) {
      return;
    }
    const [head, ...body] = tableRows;
    const th = head
      .map((cell) => `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #cfdccf;background:#f3f7f3;">${renderInlineMarkdown(escapeHtml(cell))}</th>`)
      .join("");
    const rows = body
      .map((row) =>
        `<tr>${row.map((cell) => `<td style="padding:5px 10px;border-bottom:1px solid #e4ebe4;">${renderInlineMarkdown(escapeHtml(cell))}</td>`).join("")}</tr>`
      )
      .join("");
    html.push(`<table style="border-collapse:collapse;margin:8px 0 14px;font-size:13px;width:100%;">${`<tr>${th}</tr>`}${rows}</table>`);
    tableRows = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push(`<pre style="background:#101712;color:#d7e8d9;border-radius:8px;padding:12px;overflow-x:auto;font-size:12px;">${escapeHtml(codeLines.join("\n"))}</pre>`);
        codeLines = [];
      } else {
        flushList();
        flushTable();
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const tableMatch = line.match(/^\s*\|(.+)\|\s*$/);
    if (tableMatch) {
      const cells = tableMatch[1].split("|").map((cell) => cell.trim());
      // Separator rows (|---|---|) delimit the header; skip them.
      if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
        tableRows.push(cells);
      }
      continue;
    }
    flushTable();

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const sizes = ["20px", "17px", "15px", "14px"];
      html.push(
        `<h${level + 1} style="margin:16px 0 6px;font-size:${sizes[level - 1]};color:#1f2d22;">${renderInlineMarkdown(escapeHtml(headingMatch[2]))}</h${level + 1}>`
      );
      continue;
    }

    const listMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (listMatch) {
      listItems.push(`<li style="margin:2px 0;">${renderInlineMarkdown(escapeHtml(listMatch[1]))}</li>`);
      continue;
    }
    flushList();

    if (line.trim().length === 0) {
      continue;
    }
    html.push(`<p style="margin:6px 0;">${renderInlineMarkdown(escapeHtml(line))}</p>`);
  }
  flushList();
  flushTable();
  if (inCode && codeLines.length > 0) {
    html.push(`<pre style="background:#101712;color:#d7e8d9;border-radius:8px;padding:12px;overflow-x:auto;font-size:12px;">${escapeHtml(codeLines.join("\n"))}</pre>`);
  }
  return html.join("\n");
}

function formatMetaRow(label: string, value: string, color?: string): string {
  return (
    `<tr>` +
    `<td style="padding:4px 14px 4px 0;color:#68776b;white-space:nowrap;">${escapeHtml(label)}</td>` +
    `<td style="padding:4px 0;font-weight:600;color:${color ?? "#1f2d22"};">${escapeHtml(value)}</td>` +
    `</tr>`
  );
}

/**
 * Report files a run may leave next to the server root. Read fresh at report
 * build time, but only when the file was (re)written by that run — a stale
 * report from an older run must not be presented as this run's result.
 */
export async function collectRunArtifacts(
  serverRoot: string,
  record: MaintenanceRunRecord
): Promise<MaintenanceReportArtifact[]> {
  const candidates: Array<{ filename: string; contentType: string }> = [
    { filename: "migration-report.md", contentType: "text/markdown" },
    { filename: "migration-report.json", contentType: "application/json" }
  ];
  const artifacts: MaintenanceReportArtifact[] = [];
  const runStarted = new Date(record.startedAt ?? record.at).getTime();
  for (const candidate of candidates) {
    const filePath = path.join(serverRoot, candidate.filename);
    try {
      const stat = await fs.stat(filePath);
      // 60s of slack for clock/fs-timestamp granularity.
      if (Number.isFinite(runStarted) && stat.mtimeMs < runStarted - 60_000) {
        continue;
      }
      const content = await fs.readFile(filePath, "utf8");
      if (content.length > 2 * 1024 * 1024) {
        continue;
      }
      artifacts.push({ ...candidate, content });
    } catch {
      // Absent file — the run simply didn't produce this artifact.
    }
  }
  return artifacts;
}

export function buildMaintenanceReport(
  record: MaintenanceRunRecord,
  artifacts: MaintenanceReportArtifact[]
): MaintenanceReport {
  const status = record.ok ? "SUCCEEDED" : "FAILED";
  const mode = record.dryRun ? "dry run (preview)" : "real run";
  const subject = `[PokeCraft maintenance] ${record.actionName} — ${status}${record.dryRun ? " (dry run)" : ""}`;

  const sections: string[] = [];
  sections.push(
    `<table style="border-collapse:collapse;font-size:14px;margin:0 0 18px;">` +
      formatMetaRow("Action", record.actionName) +
      formatMetaRow("Status", `${status} (exit code ${record.exitCode ?? "?"})`, record.ok ? "#2f7a3b" : "#b04a3a") +
      formatMetaRow("Mode", mode) +
      formatMetaRow("Finished", record.at) +
      formatMetaRow("Requested by", record.by) +
      `</table>`
  );

  const markdownArtifact = artifacts.find((artifact) => artifact.filename.endsWith(".md"));
  if (markdownArtifact) {
    sections.push(`<h2 style="margin:20px 0 8px;font-size:18px;color:#1f2d22;">Report — ${escapeHtml(markdownArtifact.filename)}</h2>`);
    sections.push(`<div style="border:1px solid #e4ebe4;border-radius:10px;padding:6px 16px;">${renderMarkdownToHtml(markdownArtifact.content)}</div>`);
  }
  const jsonArtifact = artifacts.find((artifact) => artifact.filename.endsWith(".json"));
  if (jsonArtifact && !markdownArtifact) {
    // Only render raw JSON when there is no readable markdown twin; the JSON
    // is still attached to the email either way.
    let pretty = jsonArtifact.content;
    try {
      pretty = JSON.stringify(JSON.parse(jsonArtifact.content), null, 2);
    } catch {
      // Leave as-is.
    }
    sections.push(`<h2 style="margin:20px 0 8px;font-size:18px;color:#1f2d22;">Report — ${escapeHtml(jsonArtifact.filename)}</h2>`);
    sections.push(`<pre style="background:#f3f7f3;border-radius:8px;padding:12px;overflow-x:auto;font-size:12px;">${escapeHtml(pretty.slice(0, 200_000))}</pre>`);
  }

  sections.push(`<h2 style="margin:20px 0 8px;font-size:18px;color:#1f2d22;">Console output${record.truncated ? " (truncated)" : ""}</h2>`);
  sections.push(
    `<pre style="background:#101712;color:#d7e8d9;border-radius:10px;padding:14px;overflow-x:auto;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;">${escapeHtml(record.output)}</pre>`
  );

  const html =
    `<!DOCTYPE html><html><body style="margin:0;background:#f0f4f0;padding:24px;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f2d22;">` +
    `<div style="max-width:860px;margin:0 auto;background:#ffffff;border-radius:14px;padding:26px 30px;">` +
    `<h1 style="margin:0 0 4px;font-size:22px;color:#1f2d22;">PokeCraft maintenance report</h1>` +
    `<p style="margin:0 0 18px;color:#68776b;">Generated by the admin panel's Maintenance tools.</p>` +
    sections.join("\n") +
    `</div></body></html>`;

  const textParts = [
    `PokeCraft maintenance report`,
    `Action: ${record.actionName}`,
    `Status: ${status} (exit code ${record.exitCode ?? "?"})`,
    `Mode: ${mode}`,
    `Finished: ${record.at}`,
    `Requested by: ${record.by}`,
    ``,
    ...(markdownArtifact ? [`--- ${markdownArtifact.filename} ---`, markdownArtifact.content, ``] : []),
    `--- Console output${record.truncated ? " (truncated)" : ""} ---`,
    record.output
  ];

  const attachments: MaintenanceReportArtifact[] = [
    ...artifacts,
    { filename: `${record.actionId}-console.txt`, contentType: "text/plain", content: record.output }
  ];

  return { subject, html, text: textParts.join("\n"), attachments };
}
