import { Request, Response } from "express";
import logger from "../config/logger";
import { getSession } from "../services/session";
import {
  getChatMessages,
  getUniversalPersona,
} from "../services/persistence/chatPersistenceService";
import { connectMongo, getCollection } from "../services/database/mongoService";
import type { Document } from "mongodb";

/**
 * Get all contacts with persona data for a session
 * GET /persona/:code/contacts
 */
export async function getPersonaContacts(req: Request, res: Response) {
  try {
    const { code } = req.params;
    const session = getSession(code);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    await connectMongo();
    const contacts = getCollection<Document>("contacts");

    // Get all contacts for this session with message counts
    const contactDocs = await contacts
      .find({ sessionCode: code })
      .project({
        contactId: 1,
        messageCount: 1,
        lastMessageAt: 1,
        createdAt: 1,
        messages: { $slice: -1 }, // Get last message for preview
      })
      .sort({ lastMessageAt: -1 })
      .toArray();

    const contactList = contactDocs.map((doc) => ({
      contactId: doc.contactId,
      messageCount: doc.messageCount || 0,
      lastMessageAt: doc.lastMessageAt,
      createdAt: doc.createdAt,
      lastMessage: doc.messages?.[0]?.message || "",
    }));

    res.json({
      contacts: contactList,
      total: contactList.length,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to get persona contacts");
    res.status(500).json({ error: "Failed to retrieve contacts" });
  }
}

/**
 * Get persona messages for a specific contact
 * GET /persona/:code/contact/:contactId
 */
export async function getContactPersona(req: Request, res: Response) {
  try {
    const { code, contactId } = req.params;
    const session = getSession(code);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const messages = await getChatMessages(code, contactId);

    // Separate messages by type
    const userMessages = messages.filter((m) =>
      m.message.startsWith("User: ")
    );
    const myReplies = messages.filter((m) =>
      m.message.startsWith("My reply: ")
    );
    const aiReplies = messages.filter((m) =>
      m.message.startsWith("AI reply: ")
    );

    res.json({
      contactId,
      total: messages.length,
      userMessages: userMessages.length,
      myReplies: myReplies.length,
      aiReplies: aiReplies.length,
      messages: messages.map((m, index) => ({
        id: index,
        message: m.message,
        timestamp: m.timestamp,
      })),
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to get contact persona");
    res.status(500).json({ error: "Failed to retrieve contact persona" });
  }
}

/**
 * Get universal persona for a session
 * GET /persona/:code/universal
 */
export async function getUniversalPersonaData(req: Request, res: Response) {
  try {
    const { code } = req.params;
    const session = getSession(code);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const messages = await getUniversalPersona(code);

    res.json({
      total: messages.length,
      messages: messages.map((msg, index) => ({
        id: index,
        message: msg,
      })),
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to get universal persona");
    res.status(500).json({ error: "Failed to retrieve universal persona" });
  }
}

/**
 * Delete a message from contact persona
 * DELETE /persona/:code/contact/:contactId/message/:messageIndex
 */
export async function deleteContactMessage(req: Request, res: Response) {
  try {
    const { code, contactId, messageIndex } = req.params;
    const session = getSession(code);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const index = parseInt(messageIndex, 10);
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: "Invalid message index" });
    }

    await connectMongo();
    const contacts = getCollection<Document>("contacts");

    // Get current messages
    const doc = await contacts.findOne({ sessionCode: code, contactId });
    if (!doc || !Array.isArray(doc.messages)) {
      return res.status(404).json({ error: "Contact not found" });
    }

    if (index >= doc.messages.length) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Remove message at index
    doc.messages.splice(index, 1);

    // Update document
    await contacts.updateOne(
      { sessionCode: code, contactId },
      {
        $set: {
          messages: doc.messages,
          messageCount: doc.messages.length,
          updatedAt: new Date(),
        },
      }
    );

    res.json({ success: true, remainingMessages: doc.messages.length });
  } catch (error) {
    logger.error({ err: error }, "Failed to delete contact message");
    res.status(500).json({ error: "Failed to delete message" });
  }
}

/**
 * Delete a message from universal persona
 * DELETE /persona/:code/universal/message/:messageIndex
 */
export async function deleteUniversalMessage(req: Request, res: Response) {
  try {
    const { code, messageIndex } = req.params;
    const session = getSession(code);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const index = parseInt(messageIndex, 10);
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: "Invalid message index" });
    }

    await connectMongo();
    const universal = getCollection<Document>("universalPersonas");

    // Get current messages
    const doc = await universal.findOne({ sessionCode: code });
    if (!doc || !Array.isArray(doc.messages)) {
      return res.status(404).json({ error: "Universal persona not found" });
    }

    if (index >= doc.messages.length) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Remove message at index
    doc.messages.splice(index, 1);

    // Update document
    await universal.updateOne(
      { sessionCode: code },
      {
        $set: {
          messages: doc.messages,
          updatedAt: new Date(),
        },
      }
    );

    res.json({ success: true, remainingMessages: doc.messages.length });
  } catch (error) {
    logger.error({ err: error }, "Failed to delete universal message");
    res.status(500).json({ error: "Failed to delete message" });
  }
}

/**
 * Update a message in contact persona
 * PUT /persona/:code/contact/:contactId/message/:messageIndex
 */
export async function updateContactMessage(req: Request, res: Response) {
  try {
    const { code, contactId, messageIndex } = req.params;
    const { message } = req.body;
    const session = getSession(code);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Invalid message" });
    }

    const index = parseInt(messageIndex, 10);
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: "Invalid message index" });
    }

    await connectMongo();
    const contacts = getCollection<Document>("contacts");

    // Get current messages
    const doc = await contacts.findOne({ sessionCode: code, contactId });
    if (!doc || !Array.isArray(doc.messages)) {
      return res.status(404).json({ error: "Contact not found" });
    }

    if (index >= doc.messages.length) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Update message at index
    doc.messages[index].message = message.trim();

    // Update document
    await contacts.updateOne(
      { sessionCode: code, contactId },
      {
        $set: {
          messages: doc.messages,
          updatedAt: new Date(),
        },
      }
    );

    res.json({ success: true, message: doc.messages[index] });
  } catch (error) {
    logger.error({ err: error }, "Failed to update contact message");
    res.status(500).json({ error: "Failed to update message" });
  }
}

/**
 * Update a message in universal persona
 * PUT /persona/:code/universal/message/:messageIndex
 */
export async function updateUniversalMessage(req: Request, res: Response) {
  try {
    const { code, messageIndex } = req.params;
    const { message } = req.body;
    const session = getSession(code);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Invalid message" });
    }

    const index = parseInt(messageIndex, 10);
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: "Invalid message index" });
    }

    await connectMongo();
    const universal = getCollection<Document>("universalPersonas");

    // Get current messages
    const doc = await universal.findOne({ sessionCode: code });
    if (!doc || !Array.isArray(doc.messages)) {
      return res.status(404).json({ error: "Universal persona not found" });
    }

    if (index >= doc.messages.length) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Update message at index
    doc.messages[index] = message.trim();

    // Update document
    await universal.updateOne(
      { sessionCode: code },
      {
        $set: {
          messages: doc.messages,
          updatedAt: new Date(),
        },
      }
    );

    res.json({ success: true, message: doc.messages[index] });
  } catch (error) {
    logger.error({ err: error }, "Failed to update universal message");
    res.status(500).json({ error: "Failed to update message" });
  }
}
