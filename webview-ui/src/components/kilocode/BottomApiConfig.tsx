import { ModelSelector } from "./chat/ModelSelector"
import { ReasoningEffortSelector } from "./chat/ReasoningEffortSelector"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useSelectedModel } from "../ui/hooks/useSelectedModel"

export const BottomApiConfig = () => {
	const { currentApiConfigName, apiConfiguration, virtualQuotaActiveModel } = useExtensionState() // kilocode_change: Get virtual quota active model for UI display
	const {
		id: selectedModelId,
		provider: selectedProvider,
		info: selectedModelInfo,
	} = useSelectedModel(apiConfiguration)

	if (!apiConfiguration) {
		return null
	}

	return (
		<>
			{/* kilocode_change - add data-testid="model-selector" below */}
			<div className="min-w-0 w-auto overflow-hidden" data-testid="model-selector">
				<ModelSelector
					currentApiConfigName={currentApiConfigName}
					apiConfiguration={apiConfiguration}
					fallbackText={`${selectedProvider}:${selectedModelId}`}
					//kilocode_change: Pass virtual quota active model to ModelSelector
					virtualQuotaActiveModel={
						virtualQuotaActiveModel
							? {
									id: virtualQuotaActiveModel.id,
									name: virtualQuotaActiveModel.id,
									activeProfileNumber: virtualQuotaActiveModel.activeProfileNumber,
								}
							: undefined
					}
				/>
			</div>
			<ReasoningEffortSelector
				currentApiConfigName={currentApiConfigName}
				apiConfiguration={apiConfiguration}
				modelInfo={selectedModelInfo}
			/>
		</>
	)
}
