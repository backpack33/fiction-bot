const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

// Configuration - YOU'LL REPLACE THESE WITH YOUR ACTUAL VALUES
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // From BotFather
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; // From OpenRouter
const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID; // Your Telegram ID

// Safety limits
const DAILY_MESSAGE_LIMIT = 50;
const DAILY_SPENDING_LIMIT = 2.00; // $2 per day max
const TELEGRAM_MESSAGE_LIMIT = 3500; // Updated from 4000 to 3500

// Bot storage with file persistence
let botMemory = {
  writingRules: null, // MANDATORY - universal writing requirements
  currentStory: {
    characterSheet: null,    // NEW: Character descriptions, motivations, etc.
    storyOutline: null,      // NEW: Detailed plot with ###Chapter X sections
    title: null,
    chapters: {},
    startDate: null,
    continuationState: null // NEW: tracks if we're continuing a chapter
  },
  setupState: null, // Now tracks: null, 'expecting_writing_rules', 'expecting_character_sheet', 'expecting_story_outline'
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

// File persistence functions
function saveMemory() {
  try {
    fs.writeFileSync('botMemory.json', JSON.stringify(botMemory, null, 2));
    console.log('Memory saved to file');
  } catch (error) {
    console.error('Error saving memory:', error);
  }
}

function loadMemory() {
  try {
    if (fs.existsSync('botMemory.json')) {
      const data = fs.readFileSync('botMemory.json', 'utf8');
      botMemory = JSON.parse(data);
      console.log('Memory loaded from file');
    }
  } catch (error) {
    console.error('Error loading memory:', error);
  }
}

// Load saved data on startup
loadMemory();

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
      const prefix = `📖 **Chapter Part ${i + 1}/${chunks.length}**\n\n`;
      await bot.sendMessage(userId, prefix + chunk, isLast ? options : {});
    } else {
      await bot.sendMessage(userId, chunk, options);
    }
    
    // Increased delay to prevent rate limiting with multiple messages
    if (!isLast) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
}

// Helper function to extract specific chapter from story outline
function extractChapterOutline(storyOutline, chapterNumber) {
  if (!storyOutline) return null;
  
  const chapterMarker = `###Chapter ${chapterNumber}`;
  const nextChapterMarker = `###Chapter ${chapterNumber + 1}`;
  
  const startIndex = storyOutline.indexOf(chapterMarker);
  if (startIndex === -1) {
    return null; // Chapter not found
  }
  
  const nextIndex = storyOutline.indexOf(nextChapterMarker);
  const endIndex = nextIndex === -1 ? storyOutline.length : nextIndex;
  
  return storyOutline.substring(startIndex, endIndex).trim();
}

// AI Integration with mandatory rules and continuation support
async function callClaude(prompt, chapterNumber = null, includeRecentChapters = false, isContinuation = false) {
  try {
    let fullContext = "";
    
    // MANDATORY writing rules - use stronger language
    if (botMemory.writingRules) {
      fullContext += `MANDATORY WRITING REQUIREMENTS - YOU MUST FOLLOW THESE EXACTLY:\n${botMemory.writingRules}\n\nThese are non-negotiable rules. Failure to follow them will result in rejection of the output.\n\n`;
    }
    
    // ALWAYS include character sheet
    if (botMemory.currentStory.characterSheet) {
      fullContext += `CHARACTER SHEET (MANDATORY REFERENCE):\n${botMemory.currentStory.characterSheet}\n\n`;
    }
    
    // Include specific chapter outline if chapter number provided
    if (chapterNumber && botMemory.currentStory.storyOutline) {
      const chapterOutline = extractChapterOutline(botMemory.currentStory.storyOutline, chapterNumber);
      if (chapterOutline) {
        fullContext += `CHAPTER ${chapterNumber} REQUIREMENTS:\n${chapterOutline}\n\n`;
      } else {
        console.warn(`Chapter ${chapterNumber} outline not found`);
        fullContext += `STORY OUTLINE:\n${botMemory.currentStory.storyOutline}\n\n`;
      }
    }
    
    // Include recent chapters for context if requested
    if (includeRecentChapters) {
      const recentChapters = Object.keys(botMemory.currentStory.chapters)
        .filter(key => key.includes('_approved'))
        .sort((a, b) => {
          const aNum = parseInt(a.match(/chapter_(\d+)/)[1]);
          const bNum = parseInt(b.match(/chapter_(\d+)/)[1]);
          return aNum - bNum;
        })
        .slice(-2);
        
      if (recentChapters.length > 0) {
        fullContext += "PREVIOUS CHAPTERS FOR CONTEXT:\n";
        recentChapters.forEach(key => {
          const chapter = botMemory.currentStory.chapters[key];
          fullContext += `\nChapter ${chapter.number}:\n${chapter.content}\n`;
        });
        fullContext += "\n";
      }
    }
    
    // Add continuation context if this is a continuation
    if (isContinuation && botMemory.currentStory.continuationState) {
      fullContext += `CONTINUATION CONTEXT:\nYou are continuing a chapter that was cut off. Here is the content so far:\n\n${botMemory.currentStory.continuationState.partialContent}\n\nContinue seamlessly from where this left off. Do not repeat any content. Do not summarize what happened before. Just continue the story naturally.\n\n`;
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
      max_tokens: 8000 // Use most of the available output tokens
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
    
    // Check if response was likely truncated (near max tokens)
    const wasTruncated = outputTokens > 7500; // If very close to 8000 token limit
    
    // Update stats
    botMemory.dailyStats.messagesUsed++;
    botMemory.dailyStats.estimatedSpending += cost;
    botMemory.userStats.totalSpent += cost;
    
    return {
      success: true,
      content: aiResponse,
      cost: cost,
      tokens: { input: inputTokens, output: outputTokens },
      wasTruncated: wasTruncated
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
  
  await bot.sendMessage(userId, `📝 **Set Your MANDATORY Writing Requirements**

These are NOT suggestions - they are absolute requirements that Haiku MUST follow with every chapter across ALL stories.

Include things like:
• Your required writing style and voice
• Mandatory dialogue formatting
• Required pacing and structure rules
• POV requirements (1st person, 3rd person, etc.)
• Specific techniques that must be used
• Tone and mood requirements
• Any forbidden phrases or approaches

**Upload a .txt file or paste your complete, non-negotiable writing requirements in your next message.**`);
  
  botMemory.setupState = 'expecting_writing_rules';
}

async function handleSetupStory(msg) {
  const userId = msg.from.id;
  
  if (!botMemory.writingRules) {
    await bot.sendMessage(userId, "❌ Please set up your writing rules first with /setup_rules");
    return;
  }
  
  await bot.sendMessage(userId, `📚 **Set Up New Story - Step 1**

First, upload your **CHARACTER SHEET** document. This should include:
• Character descriptions and motivations
• Physical details and personality traits
• Backstory and relationships
• Character arcs and development

**Upload the character sheet file (.txt) or paste it in your next message.**`);
  
  botMemory.setupState = 'expecting_character_sheet';
}

async function handleNewStory(msg) {
  const userId = msg.from.id;
  
  if (!botMemory.writingRules) {
    await bot.sendMessage(userId, "❌ Set up writing rules first with /setup_rules, then use /setup_story for your first story.");
    return;
  }
  
  // Archive current story stats
  if (botMemory.currentStory.storyOutline) {
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

Use /export if you want to download it before starting your new story.`);
    }
  }
  
  // Clear current story (but keep writing rules!)
  botMemory.currentStory = {
    characterSheet: null,
    storyOutline: null,
    title: null,
    chapters: {},
    startDate: null,
    continuationState: null
  };
  
  saveMemory();
  
  await bot.sendMessage(userId, `🆕 **Ready for New Story!**
  
Your writing rules are preserved and will be used for the new story.

Next step: /setup_story to upload character sheet and story outline.`);
}

async function handleWriteChapter(msg, chapterNum) {
  const userId = msg.from.id;
  
  if (!botMemory.writingRules) {
    await bot.sendMessage(userId, "❌ No writing rules set! Use /setup_rules first.");
    return;
  }
  
  if (!botMemory.currentStory.characterSheet || !botMemory.currentStory.storyOutline) {
    await bot.sendMessage(userId, "❌ Missing story setup! Use /setup_story first.");
    return;
  }
  
  // Clear any existing continuation state
  botMemory.currentStory.continuationState = null;
  
  await bot.sendMessage(userId, `🤖 Writing Chapter ${chapterNum}... This may take 30-90 seconds for a full chapter.`);
  
  const prompt = `Write Chapter ${chapterNum} of this story. Write as much as needed to fully develop the chapter according to the chapter outline - do not artificially limit length.

Write engaging, immersive fiction that continues the story naturally. Focus on character development, dialogue, and moving the plot forward according to the character sheet, chapter outline, and MANDATORY writing requirements provided above.

Remember: You must follow all writing rules exactly as specified. They are non-negotiable requirements, not suggestions.`;

  const result = await callClaude(prompt, chapterNum, false, false);
  
  if (result.success) {
    // Store as version 1
    const chapterKey = `chapter_${chapterNum}_v1`;
    botMemory.currentStory.chapters[chapterKey] = {
      number: chapterNum,
      version: 1,
      content: result.content,
      timestamp: new Date(),
      approved: false,
      wasTruncated: result.wasTruncated
    };
    
    // Set up continuation state if truncated
    if (result.wasTruncated) {
      botMemory.currentStory.continuationState = {
        chapterNumber: chapterNum,
        chapterKey: chapterKey,
        partialContent: result.content
      };
    }
    
    const wordCount = result.content.split(' ').length;
    botMemory.userStats.totalWords += wordCount;
    
    saveMemory();
    
    let responseText = `📖 **Chapter ${chapterNum} v1** (${wordCount.toLocaleString()} words)\n\n${result.content}\n\n💰 Cost: $${result.cost.toFixed(4)}`;
    
    if (result.wasTruncated) {
      responseText += `\n\n⚠️ **Chapter appears to be cut off due to length.** Use /continue to extend it, or /feedback if you want changes, or /approved if it's complete as-is.`;
    } else {
      responseText += `\n\nCommands: /feedback [your feedback] or /approved`;
    }
    
    await sendLongMessage(userId, responseText);
  } else {
    await bot.sendMessage(userId, `❌ ${result.error}`);
  }
}

// Handle continue command for extending chapters
async function handleContinue(msg) {
  const userId = msg.from.id;
  
  if (!botMemory.currentStory.continuationState) {
    await bot.sendMessage(userId, "❌ No chapter to continue. Use this command when a chapter was cut off due to length.");
    return;
  }
  
  const state = botMemory.currentStory.continuationState;
  
  await bot.sendMessage(userId, `📝 Continuing Chapter ${state.chapterNumber}... Adding more content.`);
  
  const prompt = `Continue writing this chapter from exactly where it left off. Do not repeat any existing content. Do not summarize. Just continue the story seamlessly, maintaining the same quality and style.

Write as much additional content as needed to complete the chapter according to the chapter outline.`;

  const result = await callClaude(prompt, state.chapterNumber, false, true);
  
  if (result.success) {
    // Combine the content
    const existingChapter = botMemory.currentStory.chapters[state.chapterKey];
    const combinedContent = existingChapter.content + result.content;
    
    // Update the chapter
    const newVersion = existingChapter.version + 1;
    const newChapterKey = `chapter_${state.chapterNumber}_v${newVersion}`;
    
    botMemory.currentStory.chapters[newChapterKey] = {
      ...existingChapter,
      version: newVersion,
      content: combinedContent,
      timestamp: new Date(),
      wasTruncated: result.wasTruncated
    };
    
    // Update continuation state
    if (result.wasTruncated) {
      botMemory.currentStory.continuationState.chapterKey = newChapterKey;
      botMemory.currentStory.continuationState.partialContent = combinedContent;
    } else {
      botMemory.currentStory.continuationState = null; // Chapter is complete
    }
    
    const wordCount = combinedContent.split(' ').length;
    const newWords = result.content.split(' ').length;
    botMemory.userStats.totalWords += newWords;
    
    saveMemory();
    
    let responseText = `📖 **Chapter ${state.chapterNumber} v${newVersion}** (${wordCount.toLocaleString()} words total, +${newWords.toLocaleString()} new)\n\n${combinedContent}\n\n💰 Cost: $${result.cost.toFixed(4)}`;
    
    if (result.wasTruncated) {
      responseText += `\n\n⚠️ **Chapter still appears long - may need another /continue, or use /feedback for changes, or /approved if complete.**`;
    } else {
      responseText += `\n\nCommands: /feedback [your feedback] or /approved`;
    }
    
    await sendLongMessage(userId, responseText);
  } else {
    await bot.sendMessage(userId, `❌ ${result.error}`);
  }
}

async function handleFeedback(msg, feedback) {
  const userId = msg.from.id;
  
  if (!feedback.trim()) {
    await bot.sendMessage(userId, "❌ Please provide feedback: /feedback [your detailed feedback]");
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
  
  // Clear continuation state when revising
  botMemory.currentStory.continuationState = null;
  
  await bot.sendMessage(userId, `🔄 Revising Chapter ${chapter.number} v${newVersion} based on your feedback...`);
  
  const prompt = `Revise this chapter based on the user's feedback: "${feedback}"

CURRENT CHAPTER TO REVISE:
${chapter.content}

Completely rewrite the chapter incorporating the feedback while STRICTLY following all mandatory writing requirements, character sheet, and chapter outline. Write as long as needed - no artificial word limits.

Remember: The writing rules are MANDATORY requirements, not suggestions. Follow them exactly.`;

  const result = await callClaude(prompt, chapter.number, true, false);
  
  if (result.success) {
    const newChapterKey = `chapter_${chapter.number}_v${newVersion}`;
    botMemory.currentStory.chapters[newChapterKey] = {
      number: chapter.number,
      version: newVersion,
      content: result.content,
      timestamp: new Date(),
      approved: false,
      cost: result.cost,
      wasTruncated: result.wasTruncated
    };
    
    // Set up continuation state if truncated
    if (result.wasTruncated) {
      botMemory.currentStory.continuationState = {
        chapterNumber: chapter.number,
        chapterKey: newChapterKey,
        partialContent: result.content
      };
    }
    
    const wordCount = result.content.split(' ').length;
    
    saveMemory();
    
    let responseText = `📖 **Chapter ${chapter.number} v${newVersion}** (${wordCount.toLocaleString()} words)\n\n${result.content}\n\n💰 Cost: $${result.cost.toFixed(4)}`;
    
    if (result.wasTruncated) {
      responseText += `\n\n⚠️ **Chapter appears cut off. Use /continue to extend, /feedback for more changes, or /approved if complete.**`;
    } else {
      responseText += `\n\nCommands: /feedback [more feedback] or /approved`;
    }
    
    await sendLongMessage(userId, responseText);
  } else {
    await bot.sendMessage(userId, `❌ ${result.error}`);
  }
}

function handleApproved(msg) {
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
  
  // Clear continuation state
  botMemory.currentStory.continuationState = null;
  
  botMemory.userStats.totalChapters++;
  
  saveMemory();
  
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
• Approved chapters: ${approvedChapters}
• Words: ${currentStoryWords.toLocaleString()}
• Started: ${botMemory.currentStory.startDate || 'Not started'}

🔧 **Setup Status:**
• Writing rules: ${botMemory.writingRules ? '✅ Set' : '❌ Missing'}
• Character sheet: ${botMemory.currentStory.characterSheet ? '✅ Set' : '❌ Missing'}
• Story outline: ${botMemory.currentStory.storyOutline ? '✅ Set' : '❌ Missing'}

💰 **Usage Today:**
• Messages: ${botMemory.dailyStats.messagesUsed}/${DAILY_MESSAGE_LIMIT}
• Spending: $${botMemory.dailyStats.estimatedSpending.toFixed(4)}/$${DAILY_SPENDING_LIMIT}
• Remaining: ${dailyRemaining} messages, $${dailySpendingRemaining.toFixed(4)}

📈 **All-Time Stats:**
• Total spent: $${botMemory.userStats.totalSpent.toFixed(4)}
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
  saveMemory();
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
      await bot.sendMessage(userId, "❌ File too large. Please keep documents under 1MB.");
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
        saveMemory();
        
        await bot.sendMessage(userId, `✅ **Writing rules loaded from file!** (${fileContent.length} characters)
        
📁 **File:** ${document.file_name}
        
Your universal writing requirements will now be included with every chapter request.

**Next step:** /setup_story to set up your character sheet and story outline.`);
        
      } else if (botMemory.setupState === 'expecting_character_sheet') {
        botMemory.currentStory.characterSheet = fileContent;
        botMemory.setupState = 'expecting_story_outline';
        saveMemory();
        
        await bot.sendMessage(userId, `✅ **Character sheet loaded from file!** (${fileContent.length} characters)
        
📁 **File:** ${document.file_name}
        
📋 **Now Step 2: Upload your STORY OUTLINE**

This should include:
• Detailed plot structure with ###Chapter X sections
• Story beats and pacing
• Chapter-by-chapter breakdowns
• Specific scene descriptions

**Upload the story outline file (.txt) or paste it in your next message.**`);
        
      } else if (botMemory.setupState === 'expecting_story_outline') {
        botMemory.currentStory.storyOutline = fileContent;
        botMemory.currentStory.startDate = new Date().toLocaleDateString();
        botMemory.setupState = null;
        saveMemory();
        
        await bot.sendMessage(userId, `✅ **Story setup complete!** 
        
📊 **Summary:**
• Character sheet: ${botMemory.currentStory.characterSheet.length} characters
• Story outline: ${fileContent.length} characters
• Writing rules: Active

🚀 **Ready to start:**

1. **Optional:** /set_title [Your Story Title]
2. **Start writing:** /write_chapter 1
3. **Extend if needed:** /continue
4. **Give feedback:** /feedback [your detailed feedback]  
5. **Approve:** /approved
6. **Continue:** /write_chapter 2

Ready to begin your fanfic?`);
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
    saveMemory();
    await bot.sendMessage(userId, `✅ **Writing rules saved!** (${text.length} characters)
    
Your universal writing requirements will now be included with every chapter request.

**Next step:** /setup_story to set up your character sheet and story outline.`);
    return;
  }
  
  if (botMemory.setupState === 'expecting_character_sheet' && !text.startsWith('/')) {
    botMemory.currentStory.characterSheet = text;
    botMemory.setupState = 'expecting_story_outline';
    saveMemory();
    
    await bot.sendMessage(userId, `✅ **Character sheet saved!** (${text.length} characters)
    
📋 **Now Step 2: Upload your STORY OUTLINE**

This should include:
• Detailed plot structure with ###Chapter X sections
• Story beats and pacing
• Chapter-by-chapter breakdowns
• Specific scene descriptions

**Upload the story outline file (.txt) or paste it in your next message.**`);
    return;
  }
  
  if (botMemory.setupState === 'expecting_story_outline' && !text.startsWith('/')) {
    botMemory.currentStory.storyOutline = text;
    botMemory.currentStory.startDate = new Date().toLocaleDateString();
    botMemory.setupState = null;
    saveMemory();
    
    await bot.sendMessage(userId, `✅ **Story setup complete!** 
    
📊 **Summary:**
• Character sheet: ${botMemory.currentStory.characterSheet.length} characters
• Story outline: ${text.length} characters
• Writing rules: Active

🚀 **Ready to start:**

1. **Optional:** /set_title [Your Story Title]
2. **Start writing:** /write_chapter 1
3. **Extend if needed:** /continue
4. **Give feedback:** /feedback [your detailed feedback]  
5. **Approve:** /approved
6. **Continue:** /write_chapter 2

Ready to begin your fanfic?`);
    return;
  }
  
  // Command routing
  if (text.startsWith('/start')) {
    const welcomeMsg = `🎭 **Welcome to Your Personal Fiction Writing Bot!**

I'm powered by Claude 3.5 Haiku and designed to help you write novels efficiently and affordably.

**🔥 Setup Commands (Do These First):**
• /setup_rules - Set your mandatory writing requirements
• /setup_story - Upload character sheet AND story outline

**✍️ Writing Commands:**
• /write_chapter [number] - Write a new chapter (unlimited length)
• /continue - Extend a chapter that was cut off due to length
• /feedback [feedback] - Revise current chapter with your feedback
• /approved - Approve current chapter as final

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

**📱 Pro Tip:** Chapters have NO word limit - they can be 6,000+ words. Use /continue if one gets cut off!

Ready? Start with /setup_rules!`;

    await sendLongMessage(userId, welcomeMsg);
    
  } else if (text.startsWith('/setup_rules')) {
    await handleSetupWritingRules(msg);
    
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
    
  } else if (text.startsWith('/continue')) {
    await handleContinue(msg);
    
  } else if (text.startsWith('/feedback')) {
    const feedback = text.replace('/feedback', '').trim();
    await handleFeedback(msg, feedback);
    
  } else if (text.startsWith('/approved')) {
    handleApproved(msg);
    
  } else if (text.startsWith('/status')) {
    handleStatus(msg);
    
  } else if (text.startsWith('/export')) {
    handleExport(msg);
    
  } else if (text.startsWith('/help')) {
    const helpMsg = `🎭 **Fiction Writing Bot Commands**

**🔧 Setup (Do Once):**
• /setup_rules - Your mandatory writing requirements
• /setup_story - Upload character sheet AND story outline

**✍️ Writing Workflow:**
• /write_chapter [number] - Write new chapter (unlimited length)
• /continue - Extend a chapter that was cut off due to length
• /feedback [detailed feedback] - Revise current chapter  
• /approved - Mark current chapter as final

**📊 Management:**
• /status - Progress and daily usage
• /export - Download current story
• /new_story - Start fresh story (keeps writing rules)
• /set_title [title] - Set story title

**💡 Example Workflow:**
1. /write_chapter 1
2. /continue (if chapter was cut off)
3. /feedback "add more internal monologue and slow down the pacing"
4. /approved
5. /write_chapter 2

**🔥 Pro Tips:**
• Chapters have NO word limit - they can be as long as needed
• Use /continue if a chapter gets cut off at ~6,000 words
• Writing rules are MANDATORY - Haiku must follow them exactly
• Be detailed in feedback - more detail = better results

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
console.log('💾 File persistence enabled');
console.log('🎭 Ready for fiction writing!');

// Health check endpoint for Railway
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ 
    status: 'Fiction Bot Online',
    features: [
      'Mandatory writing rules',
      'Character sheet + story outline separation', 
      'Unlimited chapter length',
      '/continue command for extending chapters',
      'File persistence',
      'Auto message splitting at 3500 chars'
    ],
    dailyStats: botMemory.dailyStats,
    userStats: botMemory.userStats,
    currentStory: {
      hasRules: !!botMemory.writingRules,
      hasCharacterSheet: !!botMemory.currentStory.characterSheet,
      hasStoryOutline: !!botMemory.currentStory.storyOutline,
      title: botMemory.currentStory.title,
      chaptersApproved: Object.keys(botMemory.currentStory.chapters).filter(k => k.includes('_approved')).length
    },
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});
