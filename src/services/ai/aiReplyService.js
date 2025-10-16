"use strict";

const { generateReply } = require("./geminiService");

/**
 * Analyze user's typing patterns for style learning
 */
function analyzeTypingPatterns(persona) {
  if (!Array.isArray(persona) || !persona.length) {
    return {};
  }

  const messages = persona.filter(entry => entry.outgoing).map(entry => entry.outgoing);
  if (!messages.length) return {};

  const lengths = messages.map(msg => msg.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;

  const emojiCount = messages.join('').match(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu)?.length || 0;
  const questionCount = messages.join('').split('?').length - 1;
  const exclamationCount = messages.join('').split('!').length - 1;

  const formalityScore = messages.some(msg =>
    msg.includes('please') || msg.includes('thank you') || msg.includes('would you') ||
    msg.includes('could you') || msg.includes('may I')
  ) ? 'formal' : 'casual';

  const emojiUsage = emojiCount / messages.length > 0.1 ? 'frequent' : emojiCount / messages.length > 0.05 ? 'moderate' : 'rare';
  const punctuationStyle = exclamationCount > questionCount ? 'exclamation' : questionCount > exclamationCount ? 'question' : 'balanced';

  // Analyze "bit by bit" messaging pattern
  const shortMessages = messages.filter(msg => msg.length < 50);
  const bitByBitRatio = shortMessages.length / messages.length;
  const messagingStyle = bitByBitRatio > 0.6 ? 'incremental' : bitByBitRatio > 0.3 ? 'mixed' : 'complete';

  // Analyze message sequences (if we have conversation pairs)
  const conversationPairs = persona.filter(entry => entry.incoming && entry.outgoing);
  let sequentialPattern = 'unknown';
  if (conversationPairs.length > 5) {
    // Look for patterns where user sends multiple messages in response to one incoming
    const userMessageSequences = [];
    let currentSequence = [];

    for (let i = 0; i < conversationPairs.length; i++) {
      const entry = conversationPairs[i];
      if (entry.incoming) {
        if (currentSequence.length > 0) {
          userMessageSequences.push(currentSequence);
          currentSequence = [];
        }
        currentSequence.push(entry.outgoing);
      } else {
        currentSequence.push(entry.outgoing);
      }
    }
    if (currentSequence.length > 0) {
      userMessageSequences.push(currentSequence);
    }

    const avgSequenceLength = userMessageSequences.reduce((sum, seq) => sum + seq.length, 0) / userMessageSequences.length;
    sequentialPattern = avgSequenceLength > 1.5 ? 'sequential' : 'single';
  }

  return {
    avgLength: Math.round(avgLength),
    formality: formalityScore,
    emojiUsage,
    punctuationStyle,
    messageCount: messages.length,
    messagingStyle, // 'incremental', 'mixed', or 'complete'
    sequentialPattern // 'sequential', 'single', or 'unknown'
  };
}

/**
 * Analyze conversation context for better AI understanding
 */
function analyzeConversationContext(augmentedHistory) {
  if (!Array.isArray(augmentedHistory) || !augmentedHistory.length) {
    return {};
  }

  const recentMessages = augmentedHistory.slice(-10); // Analyze last 10 messages
  const userMessages = recentMessages.filter(msg => msg.role === 'user').map(msg => msg.text || msg.content || '');
  const assistantMessages = recentMessages.filter(msg => msg.role === 'assistant').map(msg => msg.text || msg.content || '');

  // Analyze conversation flow
  const topics = [];
  const questionPatterns = [];
  const responsePatterns = [];

  // Extract potential topics from user messages
  userMessages.forEach(msg => {
    if (msg.toLowerCase().includes('how') || msg.toLowerCase().includes('what') || msg.toLowerCase().includes('why')) {
      questionPatterns.push('explanatory');
    }
    if (msg.toLowerCase().includes('can you') || msg.toLowerCase().includes('please')) {
      questionPatterns.push('request');
    }
    if (msg.includes('?')) {
      questionPatterns.push('question');
    }
  });

  // Analyze response patterns
  assistantMessages.forEach(msg => {
    if (msg.length > 100) {
      responsePatterns.push('detailed');
    } else if (msg.length < 50) {
      responsePatterns.push('brief');
    }
    if (msg.includes('?')) {
      responsePatterns.push('clarifying');
    }
  });

  // Determine conversation style
  const isCasual = userMessages.some(msg => msg.includes('lol') || msg.includes('haha') || msg.includes('😊') || msg.includes('🤣'));
  const isProfessional = userMessages.some(msg => msg.includes('please') || msg.includes('thank you') || msg.includes('regards'));

  return {
    recentTopics: [...new Set(topics)],
    questionPatterns: [...new Set(questionPatterns)],
    responsePatterns: [...new Set(responsePatterns)],
    conversationStyle: isProfessional ? 'professional' : isCasual ? 'casual' : 'neutral',
    messageCount: recentMessages.length,
    userMessageCount: userMessages.length,
    assistantMessageCount: assistantMessages.length
  };
}

/**
 * Enhance system prompt with persona for style learning
 */
function enhanceSystemPromptWithPersona(basePrompt, persona, augmentedHistory = [], contextWindow = 100) {
  if (!Array.isArray(persona) || !persona.length) {
    return basePrompt;
  }

  // Take up to contextWindow recent persona entries for enhanced style learning
  const recentPersona = persona.slice(-contextWindow);
  const conversationExamples = [];
  const styleExamples = [];

  // Weight recent messages more heavily
  const weightedPersona = recentPersona.map((entry, index) => ({
    ...entry,
    weight: index / recentPersona.length // More recent = higher weight
  }));

  for (const entry of weightedPersona) {
    if (entry.outgoing) {
      if (entry.incoming) {
        // Conversation pair: show how to respond to specific messages
        conversationExamples.push({
          text: `When someone says: "${entry.incoming}", I reply: "${entry.outgoing}"`,
          weight: entry.weight
        });
      } else {
        // Standalone outgoing: general style example
        styleExamples.push({
          text: `"${entry.outgoing}"`,
          weight: entry.weight
        });
      }
    }
  }

  // Sort by weight (most recent first) and take top examples
  conversationExamples.sort((a, b) => b.weight - a.weight);
  styleExamples.sort((a, b) => b.weight - a.weight);

  const typingPatterns = analyzeTypingPatterns(recentPersona);
  const conversationContext = analyzeConversationContext(augmentedHistory);

  let personaInstruction = "";

  if (conversationExamples.length > 0) {
    const topConversations = conversationExamples.slice(0, 20).map(ex => ex.text);
    personaInstruction += `\n\nHere are examples of how I respond to different types of messages:\n${topConversations.join("\n")}`;
  }

  if (styleExamples.length > 0) {
    const topStyles = styleExamples.slice(0, 25).map(ex => ex.text);
    personaInstruction += `\n\nTo match my texting style, here are examples of how I typically communicate: ${topStyles.join(", ")}.`;
  }

  // Add detailed style instructions based on analysis
  if (Object.keys(typingPatterns).length > 0) {
    personaInstruction += `\n\nMy communication style characteristics:`;
    personaInstruction += `\n- Average message length: ${typingPatterns.avgLength} characters`;
    personaInstruction += `\n- Tone: ${typingPatterns.formality}`;
    personaInstruction += `\n- Emoji usage: ${typingPatterns.emojiUsage}`;
    personaInstruction += `\n- Punctuation style: ${typingPatterns.punctuationStyle}`;
    personaInstruction += `\n- Messaging style: ${typingPatterns.messagingStyle}`;
    if (typingPatterns.sequentialPattern !== 'unknown') {
      personaInstruction += `\n- Message sequencing: ${typingPatterns.sequentialPattern}`;
    }

    personaInstruction += `\n\nPlease match these characteristics exactly when responding. Pay special attention to:`;
    personaInstruction += `\n- Message length and structure`;
    personaInstruction += `\n- Level of formality and casualness`;
    personaInstruction += `\n- Emoji usage patterns`;
    personaInstruction += `\n- Punctuation preferences`;
    personaInstruction += `\n- Overall conversational tone and personality`;

    // Special instructions for incremental messaging style
    if (typingPatterns.messagingStyle === 'incremental') {
      personaInstruction += `\n\nIMPORTANT: I tend to send messages "bit by bit" rather than in one long message. When responding:`;
      personaInstruction += `\n- Break longer responses into 2-4 shorter messages`;
      personaInstruction += `\n- Send messages sequentially as if thinking through the response`;
      personaInstruction += `\n- Keep individual messages under 100 characters when possible`;
      personaInstruction += `\n- Use natural pauses between thoughts (represented by separate messages)`;
      personaInstruction += `\n- This creates a more conversational, thinking-out-loud feel`;
    } else if (typingPatterns.messagingStyle === 'mixed') {
      personaInstruction += `\n\nSometimes I send messages incrementally, sometimes as complete thoughts. Adapt based on the context and complexity of the response.`;
    }
  }

  // Add conversation context analysis
  if (Object.keys(conversationContext).length > 0 && conversationContext.messageCount > 0) {
    personaInstruction += `\n\nCurrent conversation context:`;
    personaInstruction += `\n- Conversation style: ${conversationContext.conversationStyle}`;
    if (conversationContext.questionPatterns.length > 0) {
      personaInstruction += `\n- Recent question types: ${conversationContext.questionPatterns.join(", ")}`;
    }
    if (conversationContext.responsePatterns.length > 0) {
      personaInstruction += `\n- Expected response style: ${conversationContext.responsePatterns.join(", ")}`;
    }
    personaInstruction += `\n- Recent message count: ${conversationContext.messageCount} messages`;

    personaInstruction += `\n\nAdapt your response style to match the current conversation flow and maintain consistency with recent interactions.`;
  }

  personaInstruction += `\n\nIMPORTANT: Study the examples above carefully and respond as if YOU are the person who wrote those messages. Match the exact style, tone, and personality shown in the examples.`;

  const enhanced = basePrompt
    ? `${basePrompt}${personaInstruction}`
    : `You are a helpful AI assistant.${personaInstruction}`;

  // Limit total prompt length to avoid exceeding API limits (increased for enhanced style learning)
  return enhanced.length > 8000 ? enhanced.slice(0, 8000) + "..." : enhanced;
}

/**
 * Generate AI reply using enhanced prompt and conversation history
 */
async function generateAiReply(config, augmentedHistory, persona) {
  // Enhance system prompt with persona for style learning and conversation context
  const enhancedPrompt = enhanceSystemPromptWithPersona(
    config.systemPrompt,
    persona,
    augmentedHistory,
    config.contextWindow
  );

  // Generate reply using combined history
  const reply = await generateReply(
    {
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: enhancedPrompt,
    },
    augmentedHistory
  );

  return reply;
}

/**
 * Split a long message into multiple shorter messages based on user's style
 */
function splitMessageIntoParts(message, typingPatterns) {
  if (!message || typeof message !== 'string') {
    return [message];
  }

  // If user doesn't have incremental style, return the message as-is
  if (typingPatterns.messagingStyle !== 'incremental') {
    return [message];
  }

  // For incremental style, split longer messages
  if (message.length < 120) {
    return [message]; // Keep short messages as single
  }

  const parts = [];
  let remaining = message;

  // Split on sentence boundaries first
  const sentences = remaining.split(/(?<=[.!?])\s+/);

  for (const sentence of sentences) {
    if (sentence.length > 100) {
      // If a sentence is still too long, split on commas or natural breaks
      const subParts = sentence.split(/(?<=[,;:])\s+|(?=\s+[-•*])/);
      parts.push(...subParts.filter(part => part.trim().length > 0));
    } else {
      parts.push(sentence.trim());
    }
  }

  // If we have too many parts, combine some
  if (parts.length > 4) {
    const combined = [];
    let current = '';

    for (const part of parts) {
      if ((current + part).length < 80) {
        current += (current ? ' ' : '') + part;
      } else {
        if (current) combined.push(current);
        current = part;
      }
    }
    if (current) combined.push(current);

    return combined.slice(0, 3); // Limit to 3 messages max
  }

  return parts.filter(part => part.length > 0).slice(0, 3);
}

module.exports = {
  enhanceSystemPromptWithPersona,
  generateAiReply,
  splitMessageIntoParts,
  analyzeTypingPatterns,
};