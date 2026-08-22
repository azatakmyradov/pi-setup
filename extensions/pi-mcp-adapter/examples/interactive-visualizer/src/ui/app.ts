import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import Chart from "chart.js/auto";
import { z } from "zod";
import {
  uiStreamResultPatchNotificationSchema,
  type UiStreamResultPatchNotification,
} from "../../../../ui-stream-types.ts";

declare module "@modelcontextprotocol/ext-apps" {
  interface App {
    setNotificationHandler(
      schema: typeof uiStreamResultPatchNotificationSchema,
      handler: (notification: UiStreamResultPatchNotification) => void | Promise<void>,
    ): void;
  }
}

const app = new App({ name: "interactive-visualizer", version: "0.1.0" });
const root = document.getElementById("app")!;

let chartInstance: Chart | null = null;

interface ChartSpec {
  type: "bar" | "line" | "pie" | "doughnut";
  title?: string;
  labels: string[];
  datasets: Array<{ label: string; data: number[]; color?: string }>;
}

const chartDatasetSchema = z.object({
  label: z.string(),
  data: z.array(z.number()),
  color: z.string().optional(),
});
const chartDatasetsSchema = z.array(chartDatasetSchema);
const chartSpecSchema: z.ZodType<ChartSpec> = z.object({
  type: z.enum(["bar", "line", "pie", "doughnut"]),
  title: z.string().optional(),
  labels: z.array(z.string()),
  datasets: chartDatasetsSchema,
});
const chartInputSchema = z.object({
  type: z.enum(["bar", "line", "pie", "doughnut"]),
  title: z.string().optional(),
  labels: z.union([
    z.array(z.string()),
    z.string().transform((labels) => labels.split(",").map((label) => label.trim())),
  ]),
  datasets: z.union([
    chartDatasetsSchema,
    z.string().transform((datasets, context) => {
      try {
        const decoded = chartDatasetsSchema.safeParse(JSON.parse(datasets || "[]"));
        if (decoded.success) return decoded.data;
      } catch {
        // The validation issue below reports malformed JSON and invalid dataset members uniformly.
      }
      context.addIssue({ code: "custom", message: "Invalid chart datasets" });
      return z.NEVER;
    }),
  ]),
});
const visualizerContentSchema = z.object({
  structuredContent: z.object({
    svg: z.string().optional(),
    chart: chartSpecSchema.optional(),
  }).optional(),
});

type VisualizerContent =
  | { type: "svg"; svg: string }
  | { type: "chart"; chart: ChartSpec };

function errorMessage<TError>(error: TError): string {
  return error instanceof Error ? error.message : String(error);
}

function renderChart(spec: ChartSpec) {
  root.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = spec.title || "Chart";
  root.appendChild(header);

  const canvas = document.createElement("canvas");
  canvas.style.maxHeight = "400px";
  root.appendChild(canvas);

  chartInstance?.destroy();
  chartInstance = new Chart(canvas, {
    type: spec.type,
    data: {
      labels: spec.labels,
      datasets: spec.datasets.map((ds) => ({
        label: ds.label,
        data: ds.data,
        backgroundColor: ds.color || undefined,
        borderColor: ds.color || undefined,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
    },
  });

  appendMessageForm();
}

function renderSvg(svg: string) {
  root.innerHTML = "";
  const container = document.createElement("div");
  container.className = "svg-container";
  container.innerHTML = svg;
  root.appendChild(container);

  // Wire up clickable choice nodes
  container.addEventListener("click", async (e) => {
    if (!(e.target instanceof Element)) return;
    const target = e.target.closest("[data-choice]");
    if (!target) return;
    const choice = target.getAttribute("data-choice");
    if (!choice) return;
    const label = target.textContent?.trim() || choice;
    await app.sendMessage({ role: "user", content: [{ type: "text", text: `Chose: ${label}` }] }).catch(() => {});
  });

  appendMessageForm();
}

function appendMessageForm() {
  const form = document.createElement("form");
  form.className = "message-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Send a message to the agent...";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Send";
  form.append(input, button);
  root.appendChild(form);

  const status = document.createElement("div");
  status.className = "status";
  root.appendChild(status);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    status.textContent = "Sending...";
    try {
      await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      status.textContent = "Sent!";
      setTimeout(() => { status.textContent = ""; }, 2000);
    } catch (err) {
      status.textContent = `Failed: ${errorMessage(err)}`;
    }
  });
}

function extractContent<TPayload>(data: TPayload): VisualizerContent | undefined {
  const decoded = visualizerContentSchema.safeParse(data);
  if (!decoded.success) return undefined;
  const structuredContent = decoded.data.structuredContent;
  if (structuredContent?.svg) return { type: "svg", svg: structuredContent.svg };
  if (structuredContent?.chart) return { type: "chart", chart: structuredContent.chart };
  return undefined;
}

function renderContent(content: ReturnType<typeof extractContent>) {
  if (!content) return;
  if (content.type === "svg") renderSvg(content.svg);
  else renderChart(content.chart);
}

app.setNotificationHandler(uiStreamResultPatchNotificationSchema, (notification) => {
  renderContent(extractContent(notification.params));
});

app.ontoolresult = (result) => {
  renderContent(extractContent(result));
};

app.ontoolinput = async ({ arguments: args }) => {
  if (!args) return;
  try {
    const decoded = chartInputSchema.safeParse(args);
    if (decoded.success) {
      renderChart({
        ...decoded.data,
        title: decoded.data.title || "Chart",
      });
    }
  } catch (err) {
    root.textContent = `Error: ${errorMessage(err)}`;
  }
};

void app.connect(new PostMessageTransport(window.parent, window.parent)).catch((err) => {
  root.textContent = `Connection failed: ${errorMessage(err)}`;
});
