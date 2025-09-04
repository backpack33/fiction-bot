const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Configuration - YOU'LL REPLACE THESE WITH YOUR ACTUAL VALUES
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // From BotFather
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; // From OpenRouter
const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID; // Your Telegram ID

// Safety limits
const DAILY_MESSAGE_LIMIT = 50;
const DAILY_SPENDING_LIMIT = 2.00; // $2 per day max
const MAX_CHAPTER_LENGTH = 20000; // Words per chapter
const TELEGRAM_MESSAGE_LIMIT = 4000; // Telegram's character limit

// Bot storage (in production, you'd use a database, but this works for MVP)
let botMemory = {
  writingRules: null, // PERMANENT - your universal writing style/rules
  currentStory: {
    bible: null, // Story-specific: characters, plot, outline
    title: null,
    chapters: {},
    startDate: null
  },
  setupState: null, // Tracks what we're currently setting up
  dailyStats: {
    date: new Date().toDateString(),
    messagesUsed: 0,
    estimatedSpending: 0
  },
  userStats: {
    totalChapters: 0,
    totalWords: 0,
    totalSpent: 0,
    storiesCompleted: 0
  }
};

// Create bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Utility functions
function resetDailyStats() {
  const today = new Date().toDateString();
  if (botMemory.dailyStats.date !== today) {
    botMemory.dailyStats = {
      date: today,
      messagesUsed: 0,
      estimatedSpending: 0
    };
  }
}

function estimateTokens(text) {
  return Math.ceil(text.length / 3);
}

function estimateCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1000000) * 0.80;
  const outputCost = (outputTokens / 1000000) * 4.00;
  return inputCost + outputCost;
}

function isAuthorized(userId) {
  return userId.toString() === AUTHORIZED_USER_ID;
}

function checkDailyLimits() {
  resetDailyStats();
  
  if (botMemory.dailyStats.messagesUsed >= DAILY_MESSAGE_LIMIT) {
    return { allowed: false, reason: `Daily message limit reached (${DAILY_MESSAGE_LIMIT}). Resets at midnight.` };
  }
  
  if (botMemory.dailyStats.estimatedSpending >= DAILY_SPENDING_LIMIT) {
    return { allowed: false, reason: `Daily spending limit reached ($${DAILY_SPENDING_LIMIT}). Resets at midnight.` };
  }
  
  return { allowed: true };
}

function splitLongMessage(text, maxLength = TELEGRAM_MESSAGE_LIMIT) {
  if (text.length <= maxLength) {
    return [text];
  }
  
  const chunks = [];
  let currentChunk = '';
  const lines = text.split('\n');
  
  for (const line of lines) {
    if ((currentChunk + line + '\n').length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // If single line is too long, split by sentences
      if (line.length > maxLength) {
        const sentences = line.split('. ');
        for (const sentence of sentences) {
          if ((currentChunk + sentence + '. ').length > maxLength) {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
              currentChunk = '';
            }
            currentChunk = sentence + '. ';
          } else {
            currentChunk += sentence + '. ';
          }
        }
      } else {
        currentChunk = line + '\n';
      }
    } else {
      currentChunk += line + '\n';
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

async function sendLongMessage(userId, text, options = {}) {
  const chunks = splitLongMessage(text);
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isLast = i === chunks.length - 1;
    
    if (chunks.length > 1) {
      const prefix = `📄 **Part ${i + 1}/${chunks.length}**\n\n`;
      await bot.sendMessage(userId, prefix + chunk, isLast ? options : {});
    } else {
      await bot.sendMessage(userId, chunk, options);
    }
    
    // Small delay between chunks to avoid rate limits
    if (!isLast) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// AI Integration with full context
async function callClaude(prompt, includeRecentChapters = true) {
  try {
    let fullContext = "";
    
    // ALWAYS include writing rules
    if (botMemory.writingRules) {
      fullContext += `WRITING RULES (ALWAYS FOLLOW THESE):\n${botMemory.writingRules}\n\n`;
    }
    
    // ALWAYS include current story bible
    if (botMemory.currentStory.bible) {
      fullContext += `CURRENT STORY BIBLE:\n${botMemory.currentStory.bible}\n\n`;
    }
    
    // Include recent chapters for context
    if (includeRecentChapters) {
      const recentChapters = Object.keys(botMemory.currentStory.chapters)
        .filter(key => key.includes('_approved'))
        .sort((a, b) => {
          const aNum = parseInt(a.match(/chapter_(\d+)/)[1]);
          const bNum = parseInt(b.match(/chapter_(\d+)/)[1]);
          return aNum - bNum;
        })
        .slice(-3); // Last 3 chapters
        
      if (recentChapters.length > 0) {
        fullContext += "RECENT CHAPTERS FOR CONTEXT:\n";
        recentChapters.forEach(key => {
          const chapter = botMemory.currentStory.chapters[key];
          fullContext += `\nChapter ${chapter.number}:\n${chapter.content}\n`;
        });
        fullContext += "\n";
      }
    }
    
    const fullPrompt = fullContext + prompt;
    const inputTokens = estimateTokens(fullPrompt);
    
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'anthropic/claude-3.5-haiku',
      messages: [
        {
          role: 'user',
          content: fullPrompt
        }
      ],
      max_tokens: 4000
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fiction-bot.railway.app',
        'X-Title': 'Fiction Writing Bot'
      }
    });

    const aiResponse = response.data.choices[0].message.content;
    const outputTokens = estimateTokens(aiResponse);
    const cost = estimateCost(inputTokens, outputTokens);
    
    // Update stats
    botMemory.dailyStats.messagesUsed++;
    botMemory.dailyStats.estimatedSpending += cost;
    botMemory.userStats.totalSpent += cost;
    
    return {
      success: true,
      content: aiResponse,
      cost: cost,
      tokens: { input: inputTokens, output: outputTokens }
    };
    
  } catch (error) {
    console.error('Claude API Error:', error.response?.data || error.message);
    return {
      success: false,
      error: 'AI service temporarily unavailable. Please try again in a moment.'
    };
  }
}

// Command handlers
async function handleSetupWritingRules(msg) {
  const userId = msg.from.id;
  
  await bot.sendMessage(userId, `📝 **Set Your Universal Writing Rules**

These rules will be sent to the AI with EVERY chapter request across ALL stories.

Include things like:
• Your preferred writing style
• Dialogue preferences  
• Pacing guidelines
• POV preferences (1st person, 3rd person, etc.)
• Any specific techniques you want used
• Word count preferences
• Tone and mood guidelines

**Just paste your complete writing rules in your next message.** Don't worry about length - I'll handle long messages automatically.`);
  
  botMemory.setupState = 'expecting_writing_rules';
}

async function handleSetupStory(msg) {
  const userId = msg.from.id;
  
  if (!botMemory.writingRules) {
    await bot.sendMessage(userId, "❌ Please set up your writing rules first with /setup_rules");
    return;
  }
  
  await bot.sendMessage(userId, `📚 **Set Up New Story**

Paste your complete story bible created with Claude Sonnet 4. This should include:
• Character descriptions and motivations
• Detailed plot outline/beats
• Setting and world-building
• Story-specific rules
• Chapter breakdown
• Themes and tone for THIS story

**Just paste everything in your next message.** I'll automatically split it if it's too long for Telegram.`);
  
  botMemory.setupState = 'expecting_story_bible';
}

async function handleNewStory(msg) {
  const userId = msg.from.id;
  
  if (!botMemory.writingRules) {
    await bot.sendMessage(userId, "❌ Set up writing rules first with /setup_rules, then use /setup_story for your first story.");
    return;
  }
  
  // Archive current story stats
  if (botMemory.currentStory.bible) {
    const approvedChapters = Object.keys(botMemory.currentStory.chapters)
      .filter(key => key.includes('_approved')).length;
    
    if (approvedChapters > 0) {
      botMemory.userStats.storiesCompleted++;
      await bot.sendMessage(userId, `📚 **Previous story archived!**
      
📊 **Final Stats:**
• Chapters completed: ${approvedChapters}
• Story started: ${botMemory.currentStory.startDate}
• Words written: ${Object.values(botMemory.currentStory.chapters)
  .filter(ch => ch.approved)
  .reduce((total, ch) => total + ch.content.split(' ').length, 0).toLocaleString()}

Use /export_previous if you want to download it before starting your new story.`);
    }
  }
  
  // Clear current story (but keep writing rules!)
  botMemory.currentStory = {
    bible: null,
    title: null,
    chapters: {},
    startDate: null
  };
  
  await bot.sendMessage(userId, `🆕 **Ready for New Story!**
  
Your writing rules are preserved and will be used for the new story.

Next step: /setup_story to paste your new story bible.`);
}

async function handleWriteChapter(msg, chapterNum) {
  const userId = msg.from.id;
  
  if (!botMemory.writingRules) {
    await bot.sendMessage(userId, "❌ No writing rules set! Use /setup_rules first.");
    return;
  }
  
  if (!botMemory.currentStory.bible) {
    await bot.sendMessage(userId, "❌ No story bible set! Use /setup_story first.");
    return;
  }
  
  await bot.sendMessage(userId, `🤖 Writing Chapter ${chapterNum}... This may take 30-60 seconds.`);
  
  const prompt = `Write Chapter ${chapterNum} of this story. Make it approximately ${MAX_CHAPTER_LENGTH} words.

Write engaging, immersive fiction that continues the story naturally. Focus on character development, dialogue, and moving the plot forward according to the story bible and writing rules provided above.`;

  const result = await callClaude(prompt, true);
  
  if (result.success) {
    // Store as version 1
    const chapterKey = `chapter_${chapterNum}_v1`;
    botMemory.currentStory.chapters[chapterKey] = {
      number: chapterNum,
      version: 1,
      content: result.content,
      timestamp: new Date(),
      approved: false
    };
    
    const wordCount = result.content.split(' ').length;
    botMemory.userStats.totalWords += wordCount;
    
    const responseText = `📖 **Chapter ${chapterNum} v1** (${wordCount} words)\n\n${result.content}\n\n💰 Cost: $${result.cost.toFixed(4)}\n\nCommands: /revise [feedback] or /approve`;
    
    await sendLongMessage(userId, responseText);
  } else {
    await bot.sendMessage(userId, `❌ ${result.error}`);
  }
}

async function handleRevise(msg, feedback) {
  const userId = msg.from.id;
  
  if (!feedback.trim()) {
    await bot.sendMessage(userId, "❌ Please provide feedback: /revise [your detailed feedback]");
    return;
  }
  
  // Find the latest chapter being worked on
  const latestChapter = Object.keys(botMemory.currentStory.chapters)
    .filter(key => !key.includes('_approved'))
    .sort()
    .pop();
    
  if (!latestChapter) {
    await bot.sendMessage(userId, "❌ No chapter to revise. Use /write_chapter [number] first.");
    return;
  }
  
  const chapter = botMemory.currentStory.chapters[latestChapter];
  const newVersion = chapter.version + 1;
  
  await bot.sendMessage(userId, `🔄 Revising Chapter ${chapter.number} v${newVersion} based on your feedback...`);
  
  const prompt = `Revise this chapter based on the user's feedback: "${feedback}"

CURRENT CHAPTER TO REVISE:
${chapter.content}

Rewrite the entire chapter incorporating the feedback while following all writing rules and story bible guidelines. Keep it approximately ${MAX_CHAPTER_LENGTH} words.`;

  const result = await callClaude(prompt, false); // Don't include recent chapters for revisions
  
  if (result.success) {
    const newChapterKey = `chapter_${chapter.number}_v${newVersion}`;
    botMemory.currentStory.chapters[newChapterKey] = {
      number: chapter.number,
      version: newVersion,
      content: result.content,
      timestamp: new Date(),
      approved: false,
      cost: result.cost // Store cost for tracking
    };
    
    const wordCount = result.content.split(' ').length;
    
    const responseText = `📖 **Chapter ${chapter.number} v${newVersion}** (${wordCount} words)\n\n${result.content}\n\n💰 **Cost:** ${result.cost.toFixed(4)} (${result.tokens.input.toLocaleString()} in + ${result.tokens.output.toLocaleString()} out tokens)\n\nCommands: /revise [more feedback] or /approve`;
    
    await sendLongMessage(userId, responseText);
  } else {
    await bot.sendMessage(userId, `❌ ${result.error}`);
  }
}

function handleApprove(msg) {
  const userId = msg.from.id;
  
  // Find latest chapter
  const latestChapter = Object.keys(botMemory.currentStory.chapters)
    .filter(key => !key.includes('_approved'))
    .sort()
    .pop();
    
  if (!latestChapter) {
    bot.sendMessage(userId, "❌ No chapter to approve.");
    return;
  }
  
  const chapter = botMemory.currentStory.chapters[latestChapter];
  
  // Mark as approved
  const approvedKey = `chapter_${chapter.number}_approved`;
  botMemory.currentStory.chapters[approvedKey] = { ...chapter, approved: true };
  
  // Remove draft versions for this chapter
  Object.keys(botMemory.currentStory.chapters)
    .filter(key => key.startsWith(`chapter_${chapter.number}_v`))
    .forEach(key => delete botMemory.currentStory.chapters[key]);
  
  botMemory.userStats.totalChapters++;
  
  bot.sendMessage(userId, `✅ **Chapter ${chapter.number} approved and saved!**\n\n📊 **Current Story Progress:** ${Object.keys(botMemory.currentStory.chapters).filter(k => k.includes('_approved')).length} chapters, ${Object.values(botMemory.currentStory.chapters).filter(ch => ch.approved).reduce((total, ch) => total + ch.content.split(' ').length, 0).toLocaleString()} words\n\n🚀 **Ready for:** /write_chapter ${chapter.number + 1}`);
}

function handleStatus(msg) {
  const userId = msg.from.id;
  resetDailyStats();
  
  const approvedChapters = Object.keys(botMemory.currentStory.chapters)
    .filter(key => key.includes('_approved')).length;
    
  const currentStoryWords = Object.values(botMemory.currentStory.chapters)
    .filter(ch => ch.approved)
    .reduce((total, ch) => total + ch.content.split(' ').length, 0);
    
  const dailyRemaining = DAILY_MESSAGE_LIMIT - botMemory.dailyStats.messagesUsed;
  const dailySpendingRemaining = DAILY_SPENDING_LIMIT - botMemory.dailyStats.estimatedSpending;
  
  const status = `📊 **Fiction Bot Status**

📖 **Current Story:**
• Title: ${botMemory.currentStory.title || 'Not set'}
• Approved chapters: ${approvedChapters}/${botMemory.currentStory.totalChapters || 0}
• Words: ${currentStoryWords.toLocaleString()}
• Started: ${botMemory.currentStory.startDate || 'Not started'}

🔧 **Setup Status:**
• Writing rules: ${botMemory.writingRules ? '✅ Set' : '❌ Missing'}
• Story setup: ${botMemory.currentStory.storySetup ? '✅ Set' : '❌ Missing'}
• Chapter outlines: ${Object.keys(botMemory.currentStory.chapterOutlines).length || 0} chapters planned

💰 **Usage Today:**
• Messages: ${botMemory.dailyStats.messagesUsed}/${DAILY_MESSAGE_LIMIT}
• Spending: ${botMemory.dailyStats.estimatedSpending.toFixed(4)}/${DAILY_SPENDING_LIMIT}
• Remaining: ${dailyRemaining} messages, ${dailySpendingRemaining.toFixed(4)}

📈 **All-Time Stats:**
• Total spent: ${botMemory.userStats.totalSpent.toFixed(4)}
• Stories completed: ${botMemory.userStats.storiesCompleted}
• Total chapters: ${botMemory.userStats.totalChapters}
• Total words: ${botMemory.userStats.totalWords.toLocaleString()}`;

  bot.sendMessage(userId, status);
}

function handleExport(msg) {
  const userId = msg.from.id;
  
  const approvedChapters = Object.keys(botMemory.currentStory.chapters)
    .filter(key => key.includes('_approved'))
    .sort((a, b) => {
      const aNum = parseInt(a.match(/chapter_(\d+)/)[1]);
      const bNum = parseInt(b.match(/chapter_(\d+)/)[1]);
      return aNum - bNum;
    });
    
  if (approvedChapters.length === 0) {
    bot.sendMessage(userId, "❌ No approved chapters to export.");
    return;
  }
  
  const storyTitle = botMemory.currentStory.title || 'My Novel';
  let bookContent = `# ${storyTitle}\n\n`;
  
  if (botMemory.currentStory.startDate) {
    bookContent += `*Started: ${botMemory.currentStory.startDate}*\n*Exported: ${new Date().toLocaleDateString()}*\n\n---\n\n`;
  }
  
  approvedChapters.forEach(key => {
    const chapter = botMemory.currentStory.chapters[key];
    bookContent += `## Chapter ${chapter.number}\n\n${chapter.content}\n\n---\n\n`;
  });
  
  const totalWords = approvedChapters.reduce((total, key) => {
    return total + botMemory.currentStory.chapters[key].content.split(' ').length;
  }, 0);
  
  bookContent += `\n\n*Generated with AI assistance*\n*${approvedChapters.length} chapters, ${totalWords.toLocaleString()} words*\n*Total cost: $${botMemory.userStats.totalSpent.toFixed(4)}*`;
  
  // Send as file
  const filename = `${storyTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.txt`;
  
  bot.sendDocument(userId, Buffer.from(bookContent, 'utf8'), {
    filename: filename
  }, {
    caption: `📚 **${storyTitle}** exported!\n${approvedChapters.length} chapters • ${totalWords.toLocaleString()} words`
  });
}

async function handleSetStoryTitle(msg, title) {
  const userId = msg.from.id;
  
  if (!title.trim()) {
    await bot.sendMessage(userId, "❌ Please provide a title: /set_title My Amazing Story");
    return;
  }
  
  botMemory.currentStory.title = title.trim();
  await bot.sendMessage(userId, `✅ Story title set to: "${title.trim()}"`);
}

// Main message handler
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const text = msg.text || '';
  
  // Security check
  if (!isAuthorized(userId)) {
    bot.sendMessage(userId, "🚫 This bot is private. Access denied.");
    return;
  }
  
  // Check daily limits (except for setup commands)
  if (!text.startsWith('/setup') && !text.startsWith('/start') && !text.startsWith('/help')) {
    const limitCheck = checkDailyLimits();
    if (!limitCheck.allowed) {
      bot.sendMessage(userId, `⛔ ${limitCheck.reason}`);
      return;
    }
  }
  
  // Handle document uploads during setup
  if (msg.document && botMemory.setupState) {
    const document = msg.document;
    
    // Check if it's a text file
    if (!document.file_name.endsWith('.txt') && document.mime_type !== 'text/plain') {
      await bot.sendMessage(userId, "❌ Please upload a .txt file only.");
      return;
    }
    
    // Check file size (Telegram allows up to 50MB, but let's be reasonable)
    if (document.file_size > 1024 * 1024) { // 1MB limit
      await bot.sendMessage(userId, "❌ File too large. Please keep story bibles under 1MB.");
      return;
    }
    
    try {
      // Download the file
      const fileLink = await bot.getFileLink(document.file_id);
      const response = await axios.get(fileLink);
      const fileContent = response.data;
      
      // Handle based on setup state
      if (botMemory.setupState === 'expecting_writing_rules') {
        botMemory.writingRules = fileContent;
        botMemory.setupState = null;
        
        await bot.sendMessage(userId, `✅ **Writing rules loaded from file!** (${fileContent.length} characters)
        
📁 **File:** ${document.file_name}
        
Your universal writing rules will now be included with every chapter request.

**Next step:** /setup_story to set up your first story bible.`);
        
      } else if (botMemory.setupState === 'expecting_story_bible') {
        botMemory.currentStory.bible = fileContent;
        botMemory.currentStory.startDate = new Date().toLocaleDateString();
        botMemory.setupState = null;
        
        await bot.sendMessage(userId, `✅ **Story bible loaded from file!** (${fileContent.length} characters)
        
📁 **File:** ${document.file_name}
        
Your story is ready! Here's what happens next:

1. **Optional:** /set_title [Your Story Title]
2. **Start writing:** /write_chapter 1
3. **Revise if needed:** /revise [your feedback]  
4. **Approve:** /approve
5. **Continue:** /write_chapter 2

Ready to begin your novel?`);
      }
      
    } catch (error) {
      console.error('File download error:', error);
      await bot.sendMessage(userId, "❌ Error reading file. Please try uploading again.");
    }
    
    return;
  }
  
  // Handle setup states (expecting text input)
  if (botMemory.setupState === 'expecting_writing_rules' && !text.startsWith('/')) {
    botMemory.writingRules = text;
    botMemory.setupState = null;
    await bot.sendMessage(userId, `✅ **Writing rules saved!** (${text.length} characters)
    
Your universal writing rules will now be included with every chapter request.

**Next step:** /setup_story to set up your first story bible.`);
    return;
  }
  
  if (botMemory.setupState === 'expecting_story_bible' && !text.startsWith('/')) {
    botMemory.currentStory.bible = text;
    botMemory.currentStory.startDate = new Date().toLocaleDateString();
    botMemory.setupState = null;
    
    await bot.sendMessage(userId, `✅ **Story bible saved!** (${text.length} characters)
    
Your story is ready! Here's what happens next:

1. **Optional:** /set_title [Your Story Title]
2. **Start writing:** /write_chapter 1
3. **Revise if needed:** /revise [your feedback]  
4. **Approve:** /approve
5. **Continue:** /write_chapter 2

Ready to begin your novel?`);
    return;
  }
  
  // Command routing
  if (text.startsWith('/start')) {
    const welcomeMsg = `🎭 **Welcome to Your Personal Fiction Writing Bot!**

I'm powered by Claude 3.5 Haiku and designed to help you write novels efficiently and affordably.

**🔥 Setup Commands (Do These First):**
• /setup_rules - Set your universal writing style
• /setup_story - Set up your current story bible

**✍️ Writing Commands:**
• /write_chapter [number] - Write a new chapter
• /revise [feedback] - Revise current chapter
• /approve - Approve current chapter as final

**📊 Management Commands:**
• /status - Check progress and daily usage
• /export - Download current story
• /new_story - Start a completely new story  
• /set_title [title] - Set your story's title

**🛡️ Safety Features:**
• Only you can use this bot
• $2/day spending limit (resets at midnight)
• 50 messages/day limit
• All costs capped by your OpenRouter credits

**📱 Pro Tip:** You can send really long, detailed feedback to /revise - the bot handles it perfectly and detailed feedback = better results!

Ready? Start with /setup_rules!`;

    await sendLongMessage(userId, welcomeMsg);
    
  } else if (text.startsWith('/setup_rules')) {
    await handleSetupWritingRules(msg, false);
    
  } else if (text.startsWith('/update_rules')) {
    await handleSetupWritingRules(msg, true);
    
  } else if (text.startsWith('/setup_story')) {
    await handleSetupStory(msg);
    
  } else if (text.startsWith('/new_story')) {
    await handleNewStory(msg);
    
  } else if (text.startsWith('/set_title')) {
    const title = text.replace('/set_title', '').trim();
    await handleSetStoryTitle(msg, title);
    
  } else if (text.startsWith('/write_chapter')) {
    const chapterNum = parseInt(text.split(' ')[1]);
    if (isNaN(chapterNum) || chapterNum < 1) {
      bot.sendMessage(userId, "❌ Please specify chapter number: /write_chapter 1");
      return;
    }
    await handleWriteChapter(msg, chapterNum);
    
  } else if (text.startsWith('/revise')) {
    const feedback = text.replace('/revise', '').trim();
    await handleRevise(msg, feedback);
    
  } else if (text.startsWith('/approve')) {
    handleApprove(msg);
    
  } else if (text.startsWith('/status')) {
    handleStatus(msg);
    
  } else if (text.startsWith('/export')) {
    handleExport(msg);
    
  } else if (text.startsWith('/help')) {
    const helpMsg = `🎭 **Fiction Writing Bot Commands**

**🔧 Setup (Do Once):**
• /setup_rules - Your universal writing style
• /setup_story - Current story's characters/plot

**✍️ Writing Workflow:**
• /write_chapter [number] - Write new chapter
• /revise [detailed feedback] - Revise current chapter  
• /approve - Mark current chapter as final

**📊 Management:**
• /status - Progress and daily usage
• /export - Download current story
• /new_story - Start fresh story (keeps writing rules)
• /set_title [title] - Set story title

**💡 Example Workflow:**
1. /write_chapter 1
2. /revise "add more internal monologue and slow down the pacing in the first scene"
3. /revise "the dialogue feels stilted, make it more natural"
4. /approve
5. /write_chapter 2

**🔥 Pro Tips:**
• Be super detailed in /revise feedback
• You can revise multiple times before approving
• Voice-to-text works great for long feedback
• Bot always includes your rules + story bible + recent chapters

**🛡️ Safety:** ${DAILY_MESSAGE_LIMIT - botMemory.dailyStats.messagesUsed} messages left today.`;

    await sendLongMessage(userId, helpMsg);
    
  } else if (!text.startsWith('/')) {
    // Handle non-commands
    if (botMemory.setupState) {
      // This is handled above in setup states
    } else {
      bot.sendMessage(userId, "🤔 I didn't understand that command. Use /help to see available commands.");
    }
  } else {
    bot.sendMessage(userId, `❌ Unknown command. Use /help to see all available commands.`);
  }
});

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

// Startup message
console.log('🤖 Fiction Writing Bot starting up...');
console.log('✅ Safety limits active');
console.log(`📊 Daily limits: ${DAILY_MESSAGE_LIMIT} messages, $${DAILY_SPENDING_LIMIT} spending`);
console.log('🔐 Private mode: Only authorized user can access');
console.log('🎭 Ready for fiction writing!');

// Health check endpoint for Railway
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ 
    status: 'Fiction Bot Online',
    features: [
      'Universal writing rules',
      'Story-specific bibles', 
      'Multi-story support',
      'Auto message splitting',
      'Chapter versioning',
      'Cost tracking'
    ],
    dailyStats: botMemory.dailyStats,
    userStats: botMemory.userStats,
    currentStory: {
      hasRules: !!botMemory.writingRules,
      hasBible: !!botMemory.currentStory.bible,
      title: botMemory.currentStory.title,
      chaptersApproved: Object.keys(botMemory.currentStory.chapters).filter(k => k.includes('_approved')).length
    },
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});
