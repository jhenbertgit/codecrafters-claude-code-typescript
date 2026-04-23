import OpenAI from "openai";

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
} as const;

type ToolArgs = {
  Read: { file_path: string };
  Write: { file_path: string; content: string };
  Bash: { command: string };
};

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: { name: "Read", description: "Read the contents of a file", parameters: SCHEMAS.Read },
  },
  {
    type: "function",
    function: { name: "Write", description: "Write content to a file", parameters: SCHEMAS.Write },
  },
  {
    type: "function",
    function: { name: "Bash", description: "Execute a bash command and return the output", parameters: SCHEMAS.Bash },
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
      return await Bun.file(file_path).text();
    }
    case "Write": {
      const { file_path, content } = parseArgs("Write", args);
      await Bun.write(file_path, content);
      return `Wrote to ${file_path}`;
    }
    case "Bash": {
      const { command } = parseArgs("Bash", args);
      const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      if (exitCode === 0) return output;
      throw new Error(`Command failed with exit code ${exitCode}\n${output}${err}`);
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

function parseArgsCli(): { flag: string; prompt: string } {
  const [, , flag, prompt] = process.argv;
  if (flag !== "-p" || !prompt) {
    throw new Error("error: -p flag is required");
  }
  return { flag, prompt };
}

async function handleToolCall(call: OpenAI.ChatCompletionMessageToolCall): Promise<Message> {
  const { name, arguments: args } = call.function;
  try {
    const content = await execTool(name as ToolName, args);
    return { role: "tool", tool_call_id: call.id, content };
  } catch (err) {
    return { role: "tool", tool_call_id: call.id, content: String((err as Error).message) };
  }
}

async function chatLoop(client: OpenAI, initialPrompt: string): Promise<void> {
  const messages: Message[] = [{ role: "user", content: initialPrompt }];

  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: messages as unknown as OpenAI.ChatCompletionMessageParam[],
      tools: TOOLS,
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("no choices in response");

    const assistantMsg = {
      role: "assistant" as const,
      content: choice.message.content ?? "",
      tool_calls: choice.message.tool_calls,
    };
    messages.push(assistantMsg);

    if (!choice.message.tool_calls?.length) {
      console.log(assistantMsg.content);
      return;
    }

    for (const call of choice.message.tool_calls) {
      messages.push(await handleToolCall(call));
    }
  }
}

async function main(): Promise<void> {
  const { apiKey, baseURL } = validateEnv();
  const { prompt } = parseArgsCli();
  const client = new OpenAI({ apiKey, baseURL });
  await chatLoop(client, prompt);
}

main();
