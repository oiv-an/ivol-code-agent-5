import { AUTOCOMPLETE_PROVIDER_MODELS, AutocompleteProviderKey } from "@roo-code/types"

export { AUTOCOMPLETE_PROVIDER_MODELS }
export type { AutocompleteProviderKey }

/**
 * Check if the Kilocode account has a positive balance
 * @param kilocodeToken - The Kilocode JWT token
 * @param kilocodeOrganizationId - Optional organization ID to include in headers
 * @returns Promise<boolean> - True if balance > 0, false otherwise
 */
export async function checkKilocodeBalance(
	_kilocodeToken: string,
	_kilocodeOrganizationId?: string,
): Promise<boolean> {
	// Kilo accounts are disabled in this independent build. Fail locally without
	// making a network request, including when legacy credentials remain saved.
	return false
}
