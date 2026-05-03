import { AiMessage, AiRequestOptions, AiProviderRequest } from "../types.js";
import { raiseError } from "../raiseError.js";
import { OpenAiProvider } from "./OpenAiProvider.js";
import { validateRequestOptions, normalizeBaseUrl } from "./validateRequestOptions.js";

export class AzureOpenAiProvider extends OpenAiProvider {
  override buildRequest(messages: AiMessage[], options: AiRequestOptions): AiProviderRequest {
    validateRequestOptions(options);
    if (!options.baseUrl) {
      raiseError("base-url is required for Azure OpenAI.");
    }

    const apiVersion = options.apiVersion || "2024-02-01";
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const url = `${baseUrl}/openai/deployments/${options.model}/chat/completions?api-version=${apiVersion}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.apiKey) {
      headers["api-key"] = options.apiKey;
    }

    // Azure ships `model` in the URL deployment segment, not in the body.
    // `stream_options` is always safe because the deployment URL pins the
    // contract — there is no custom-base-url ambiguity to guard against.
    const body = this._buildBody(messages, options, {
      includeStreamOptions: true,
      includeModel: false,
    });

    return { url, headers, body: JSON.stringify(body) };
  }
}
