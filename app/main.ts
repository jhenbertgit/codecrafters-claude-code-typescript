import OpenAI from "openai";

async function main() {
  const [, , flag, prompt] = process.argv;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  if (flag !== "-p" || !prompt) {
    throw new Error("error: -p flag is required");
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
  });

  const tools = [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read the contents of a file",
            parameters: {
              type: "object",
              properties: {
                file_path: {
                  type: "string",
                  description: "The path to the file",
                },
              },
              required: ["file_path"],
            },
          },
        },
      ];
  
  
  const messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }> = [
    { role: "user", content: prompt }
  ];
  
  
  while (true) {
    const response = await client.chat.completions.create({
      model: "anthropic/claude-haiku-4.5",
      messages: messages,
      tools: tools,
    });

    if (!response.choices || response.choices.length === 0) {
      throw new Error("no choices in response");
    }

    const choice = response.choices[0];
    messages.push({ 
  role: "assistant", 
  content: choice.message.content || "",
  tool_calls: choice.message.tool_calls
});

    const toolCalls = choice.message.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      for (const call of toolCalls) {
        if (call.function.name === "Read") {
          const args = JSON.parse(call.function.arguments);
          const content = await Bun.file(args.file_path).text();
          messages.push({ role: "tool", tool_call_id: call.id, content });
        }
      }
    } else {
      console.log(choice.message.content);
      break;
    }
  }

}

main();
