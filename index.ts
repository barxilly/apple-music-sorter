import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import { webSearch } from "./webTool";
dotenv.config();

const openai = new OpenAI({
        baseURL: 'https://api.deepseek.com',
        apiKey: process.env.DEEPSEEK_API_KEY,
});

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;


const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live web. Use this whenever you are unsure about a fact: a song's mood, genre, artist, album or release date. Only use up to twice.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query. Prefer just the song and artist, e.g. 'Chocolate Salty Balls Chef'. " +
              "Do not pad it with words like genre, mood or review - they hurt relevance.",
          },
        },
        required: ["query"],
      },
    },
  },
];

async function deepseek(input: string) {
  const messages: Message[] = [
    {
      role: "system",
      content:
        "You are a music librarian. Call web_search to look things up instead of guessing. " +
        "Search first, then answer. If a search fails, do NOT treat that as proof the song is " +
        "unknown - fall back on your own knowledge and note that you could not verify it. " +
        "If a one-word answer is requested, reply with just that word.",
    },
    { role: "user", content: input },
  ];

  for (let step = 0; step < 6; step++) {
    const completion = await openai.chat.completions.create({
      messages,
      model: "deepseek-flash",
      tools,
      stream: false,
    });

    const msg = completion.choices?.[0]?.message;
    if (!msg) break;

    messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });

    const calls = msg.tool_calls ?? [];

    if (calls.length === 0) {
      console.log(msg.content?.toLowerCase());
      fs.writeFileSync("fulloutput.txt", JSON.stringify({ message: msg, transcript: messages }, null, 2));
      return msg.content;
    }

    for (const call of calls) {
      if (call.type !== "function") continue;

      const { query } = JSON.parse(call.function.arguments || "{}") as { query?: string };
      console.log(`web_search(${JSON.stringify(query)})`);

      let content: string;
      try {
        const { provider, results } = await webSearch(query ?? "");
        console.log(`   ↳ ${results.length} results via ${provider} (${results[0]?.title ?? ""})`);
        content = JSON.stringify({ provider, results });
      } catch (err) {
        // Critical: report this as a FAILURE, not as "no results found".
        // Otherwise the model reads a broken search as proof the song doesn't exist.
        const message = err instanceof Error ? err.message : String(err);
        console.log(`   ↳ search FAILED: ${message}`);
        content = JSON.stringify({
          error: "search_unavailable",
          message,
          instruction:
            "The search backend failed. This is NOT evidence that the song does not exist. " +
            "Answer from your own knowledge if you reasonably can, and state that you could not verify it.",
        });
      }

      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  console.warn("Stopped early: the model kept requesting tools.");
}

var song = "In The City"
var artist = "Charli XCX & Sam Smith"
deepseek(`Which mood most applies to this song: ${song} by ${artist}? Provide a one-word answer of sad, calm, or energetic.`);