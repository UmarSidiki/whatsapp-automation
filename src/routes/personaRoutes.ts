import { Router } from "express";
import {
  getPersonaContacts,
  getContactPersona,
  getUniversalPersonaData,
  deleteContactMessage,
  deleteUniversalMessage,
  updateContactMessage,
  updateUniversalMessage,
} from "../controllers/personaController";

const router = Router();

// Get all contacts with persona data
router.get("/:code/contacts", getPersonaContacts);

// Get persona messages for a specific contact
router.get("/:code/contact/:contactId", getContactPersona);

// Get universal persona
router.get("/:code/universal", getUniversalPersonaData);

// Delete message from contact persona
router.delete("/:code/contact/:contactId/message/:messageIndex", deleteContactMessage);

// Delete message from universal persona
router.delete("/:code/universal/message/:messageIndex", deleteUniversalMessage);

// Update message in contact persona
router.put("/:code/contact/:contactId/message/:messageIndex", updateContactMessage);

// Update message in universal persona
router.put("/:code/universal/message/:messageIndex", updateUniversalMessage);

export default router;
