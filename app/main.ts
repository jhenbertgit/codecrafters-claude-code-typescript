import OpenAI from "openai";
import { join } from "path";
import { createInterface } from "readline";
import { globSync } from "glob";
import { unlinkSync } from "fs";

let loadingInterval: ReturnType<typeof setInterval> | null = null;

function startLoading(): void {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  process.stdout.write("\r");
  loadingInterval = setInterval(() => {
    process.stdout.write(`\r${frames[i]} Tay sa!...`);
    i = (i + 1) % frames.length;
  }, 80);
}

function stopLoading(): void {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
    process.stdout.write("\r" + " ".repeat(20) + "\r");
  }
}

const MODEL = "anthropic/claude-haiku-4.5";

const SCHEMAS = {
  Read: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "The path to the file" },
    },
    required: ["file_path"] as const,
  },
  Write: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "The path to the file" },
      content: { type: "string", description: "The content to write" },
    },
    required: ["file_path", "content"] as const,
  },
  Bash: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "The bash command to execute" },
    },
    required: ["command"] as const,
  },
  Glob: {
    type: "object" as const,
    properties: {
      pattern: { type: "string", description: "The glob pattern to match files (e.g., **/*.ts)" },
    },
    required: ["pattern"] as const,
  },
  Grep: {
    type: "object" as const,
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for" },
      path: { type: "string", description: "The directory to search in (default: current)" },
    },
    required: ["pattern"] as const,
  },
  Edit: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "The path to the file" },
      old_string: { type: "string", description: "The exact string to replace" },
      new_string: { type: "string", description: "The replacement string" },
    },
    required: ["file_path", "old_string", "new_string"] as const,
  },
  Delete: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "The path to the file to delete" },
    },
    required: ["file_path"] as const,
  },
} as const;

type ToolArgs = {
  Read: { file_path: string };
  Write: { file_path: string; content: string };
  Bash: { command: string };
  Glob: { pattern: string };
  Grep: { pattern: string; path?: string };
  Edit: { file_path: string; old_string: string; new_string: string };
  Delete: { file_path: string };
};

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: { name: "Read", description: "Read the contents of a file. Supports relative paths from current working directory.", parameters: SCHEMAS.Read },
  },
  {
    type: "function",
    function: { name: "Write", description: "Write content to a file. Supports relative paths from current working directory.", parameters: SCHEMAS.Write },
  },
  {
    type: "function",
    function: { name: "Bash", description: "Execute a bash command and return the output. Runs in current working directory.", parameters: SCHEMAS.Bash },
  },
  {
    type: "function",
    function: { name: "Glob", description: "Find files matching a glob pattern. Supports **/*.ts style patterns.", parameters: SCHEMAS.Glob },
  },
  {
    type: "function",
    function: { name: "Grep", description: "Search for regex pattern in files. Returns matching lines with context.", parameters: SCHEMAS.Grep },
  },
  {
    type: "function",
    function: { name: "Edit", description: "Replace exact string in file with new string. Requires reading file first.", parameters: SCHEMAS.Edit },
  },
  {
    type: "function",
    function: { name: "Delete", description: "Delete a file. Supports relative paths from current working directory.", parameters: SCHEMAS.Delete },
  },
];

type Message = {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: OpenAI.ChatCompletionMessageToolCall[];
};

type ToolName = keyof ToolArgs;

function parseArgs<T extends ToolName>(
  name: T,
  args: string
): ToolArgs[T] {
  const parsed = JSON.parse(args);
  const schema = SCHEMAS[name];
  for (const key of schema.required) {
    if (!(key in parsed)) {
      throw new Error(`Missing required argument: ${key}`);
    }
  }
  return parsed as ToolArgs[T];
}

async function execTool(name: ToolName, args: string): Promise<string> {
  switch (name) {
    case "Read": {
      const { file_path } = parseArgs("Read", args);
      const resolvedPath = join(process.cwd(), file_path);
      return await Bun.file(resolvedPath).text();
    }
    case "Write": {
      const { file_path, content } = parseArgs("Write", args);
      const resolvedPath = join(process.cwd(), file_path);
      await Bun.write(resolvedPath, content);
      return `Wrote to ${resolvedPath}`;
    }
    case "Bash": {
      const { command } = parseArgs("Bash", args);
      const isWindows = process.platform === "win32";
      let shell: string[];
      if (isWindows) {
        const gitBash = join(process.env.ProgramFiles ?? "", "Git", "bin", "bash.exe");
        const gitBashX86 = join(process.env["ProgramFiles(x86)"] ?? "", "Git", "bin", "bash.exe");
        const bashExists = Bun.file(gitBash).size > 0 || Bun.file(gitBashX86).size > 0;
        shell = bashExists ? [gitBash, "-c"] : ["cmd.exe", "/c"];
      } else {
        shell = ["sh", "-c"];
      }
      const proc = Bun.spawn([...shell, command], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      const output = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      if (exitCode === 0) return output;
      throw new Error(`Command failed with exit code ${exitCode}\n${output}${err}`);
    }
    case "Glob": {
      const { pattern } = parseArgs("Glob", args);
      const matches = globSync(pattern, { cwd: process.cwd(), absolute: false });
      return matches.join("\n");
    }
    case "Grep": {
      const { pattern, path } = parseArgs("Grep", args);
      const searchPath = path ?? process.cwd();
      const proc = Bun.spawn(
        ["rg", pattern, searchPath, "-n", "--no-heading", "-C", "2"],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
      );
      const output = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      if (exitCode === 0 || output) return output || "No matches found";
      throw new Error(`Grep failed: ${err}`);
    }
    case "Edit": {
      const { file_path, old_string, new_string } = parseArgs("Edit", args);
      const resolvedPath = join(process.cwd(), file_path);
      const content = await Bun.file(resolvedPath).text();
      if (!content.includes(old_string)) {
        throw new Error(`old_string not found in file. Cannot edit without exact match.`);
      }
      const updated = content.replace(old_string, new_string);
      await Bun.write(resolvedPath, updated);
      return `Replaced string in ${resolvedPath}`;
    }
    case "Delete": {
      const { file_path } = parseArgs("Delete", args);
      const resolvedPath = join(process.cwd(), file_path);
      try {
        unlinkSync(resolvedPath);
        return `Deleted ${resolvedPath}`;
      } catch (err) {
        throw new Error(`Delete failed: ${(err as Error).message}`);
      }
    }
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown tool: ${_exhaustive}`);
    }
  }
}

function validateEnv(): { apiKey: string; baseURL: string } {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const baseURL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  return { apiKey, baseURL };
}

function parseArgsCli(): string {
  const [, , arg] = process.argv;
  return arg ?? "";
}

async function handleToolCall(call: OpenAI.ChatCompletionMessageToolCall): Promise<Message> {
  if (call.type !== "function") throw new Error("Unsupported tool type");
  const { name, arguments: args } = call.function;
  try {
    const content = await execTool(name as ToolName, args);
    return { role: "tool", tool_call_id: call.id, content };
  } catch (err) {
    return { role: "tool", tool_call_id: call.id, content: String((err as Error).message) };
  }
}

function handleCommand(input: string, messages: Message[]): boolean | null {
  const cmd = input.trim();
  if (cmd === "/clear") {
    messages.length = 1;
    console.log("Conversation cleared.\n");
    return true;
  }
  if (cmd === "/exit" || cmd === "exit") {
    return false;
  }
  return null;
}

async function chatLoop(client: OpenAI, initialPrompt: string): Promise<void> {
  const SYSTEM = `You are a Klawd Kod assistant. You have access to Read, Write, Bash, Glob, Grep, Edit, and Delete tools.
When user asks to read/edit/delete files, run commands, search code, or find files, use the tools. Be concise.`;
  let messages: Message[] = [{ role: "system", content: SYSTEM }];

  if (initialPrompt) {
    const cmdResult = handleCommand(initialPrompt, messages);
    if (cmdResult === false) return;
    if (cmdResult !== true) messages.push({ role: "user", content: initialPrompt });
  } else {
    console.log("\n> ");
    const firstPrompt = await readPrompt();
    if (!firstPrompt) return;
    const cmdResult = handleCommand(firstPrompt, messages);
    if (cmdResult === false) return;
    if (cmdResult !== true) messages.push({ role: "user", content: firstPrompt });
  }

  while (true) {
    startLoading();
    const stream = await client.chat.completions.create({
      model: MODEL,
      messages: messages as unknown as OpenAI.ChatCompletionMessageParam[],
      tools: TOOLS,
      max_tokens: 4096,
      stream: true,
    });
    stopLoading();

    let fullContent = "";
    let toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        process.stdout.write(delta.content);
        fullContent += delta.content;
      }

      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          if (toolCall.index !== undefined) {
            if (!toolCalls[toolCall.index]) {
              toolCalls[toolCall.index] = {
                id: toolCall.id ?? "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            const tc = toolCalls[toolCall.index];
            if (toolCall.id) tc.id = toolCall.id;
            if (toolCall.function?.name) tc.function.name = toolCall.function.name;
            if (toolCall.function?.arguments) tc.function.arguments += toolCall.function.arguments;
          }
        }
      }
    }

    const assistantMsg = {
      role: "assistant" as const,
      content: fullContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    messages.push(assistantMsg);

    if (toolCalls.length === 0) {
      console.log();
      const nextPrompt = await readPrompt();
      if (nextPrompt === null) break;
      const cmdResult = handleCommand(nextPrompt, messages);
      if (cmdResult === false) break;
      if (cmdResult !== true) messages.push({ role: "user", content: nextPrompt });
      continue;
    }

    for (const call of toolCalls) {
      messages.push(await handleToolCall(call));
    }
  }
}

function readPrompt(): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("> ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const { apiKey, baseURL } = validateEnv();
  const prompt = parseArgsCli();
  const client = new OpenAI({ apiKey, baseURL });
  console.log("Klawd Kod. Commands: /clear, /exit\n");
  await chatLoop(client, prompt);
}

main();
