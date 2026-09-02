// kilocode_change - new file
import { KiloOrganization } from "../../shared/kilocode/organization"

/**
 * Service for fetching and managing IVOL Code organization settings
 */
export class OrganizationService {
	/**
	 * Fetches organization details from the Kilo API
	 * @param kilocodeToken - The authentication token
	 * @param organizationId - The organization ID
	 * @param kilocodeTesterWarningsDisabledUntil - Timestamp for suppressing tester warnings
	 * @returns The organization object with settings
	 */
	public static async fetchOrganization(
		_kilocodeToken: string,
		_organizationId: string,
		_kilocodeTesterWarningsDisabledUntil?: number,
	): Promise<KiloOrganization | null> {
		// Organization cloud services are intentionally disabled in this fork.
		return null
	}

	/**
	 * Checks if code indexing is enabled for an organization
	 * @param organization - The organization object
	 * @returns true if code indexing is enabled (defaults to false if not specified)
	 */
	public static isCodeIndexingEnabled(organization: KiloOrganization | null): boolean {
		// Default to true if organization is null or setting is not specified
		return organization?.settings?.code_indexing_enabled ?? false
	}
}
