/**
 * The model catalog this deployment offers its pickers.
 *
 * The kernel splits the two authorities on purpose (see `ModelCatalogPort`): the
 * ENDPOINT owns the model ids (`GET /models`), the SURFACE owns the metadata.
 * This file is the surface's half.
 *
 * Noa's endpoint publishes ids and nothing else — measured, not assumed: this
 * product's gateway answers `GET /models` with `id` / `object` / `created` /
 * `owned_by` / `supported_endpoint_types`, and no modality or window anywhere. So
 * the metadata comes from models.dev (`models-dev.ts`), and this file is where
 * the precedence between it and the operator is owned:
 *
 *     operator override → models.dev → unknown
 *
 * The rule itself lives in core (`resolveCapabilities`), because the settings
 * page and the request builder must not be able to disagree about it. This file
 * only supplies the two inputs.
 *
 * Why it exists at all: without a catalog the kernel publishes no `models` seat,
 * and the chat's `/model` answered 「这个进程没有模型座位（端点未配置或不可切换），
 * 换模型请在设置页操作」 — a sentence with two problems. The endpoint WAS configured
 * (the process was talking to it), and there is no settings page in Noa to go to.
 * Supplying this port is what turns `/model` from that dead end into a real switch.
 */
import { resolveCapabilities, type ModelCapabilities, type ModelCatalogPort } from '@noa/core';
import { capabilitiesFrom, type ModelsDevAnswer, type ModelsDevIndex } from './models-dev.js';

/** What this deployment can say about its models, beyond the endpoint's ids. */
export interface CatalogOptions {
  /**
   * models.dev, loaded once at boot. Absent when it could not be loaded at all,
   * which is a supported state: every lookup then answers "unknown".
   */
  modelsDev?: ModelsDevIndex;
  /**
   * The operator's own declaration for the model in `provider.model`.
   *
   * Needed because models.dev does not always know: a gateway alias like
   * `DeepSeek-V4-Flash` resolves to ~40 disagreeing entries, and one gateway's
   * spelling may not appear at all (`GLM-4V-Flash` does not). When the automatic
   * source cannot answer, the operator is the only remaining authority — and
   * when it CAN answer, an override still wins, because they may know better.
   *
   * One field for the model in force rather than a `models[]` catalog: in this
   * contract a non-empty `models[]` IS the picker's whole menu, and Noa has no
   * settings page from which to manage such a list. Declaring a modality must
   * not silently reduce `/model` to a single row.
   */
  inputModalities?: readonly string[];
  /** A line per lookup that could not be answered, for the boot log. */
  log?: (message: string) => void;
}

/**
 * The port, labelled with the endpoint it belongs to.
 *
 * `label` is the endpoint's host, because that is what the operator recognises in
 * a menu: the same model id means different things on different gateways, and the
 * heading is the one place that distinction is visible.
 * @param baseURL - the configured endpoint.
 * @param options - the metadata sources (see `CatalogOptions`).
 * @returns the catalog port.
 */
export function modelCatalogPort(baseURL: string, options: CatalogOptions = {}): ModelCatalogPort {
  const override: ModelCapabilities | undefined = options.inputModalities === undefined
    ? undefined
    : { inputModalities: options.inputModalities };
  return {
    label: hostOf(baseURL) ?? '当前端点',
    // No metadata source in this product for names or windows: an id renders as
    // itself, with no percentage on a context gauge. Not a stub to be filled in
    // later so much as the truth about a deployment that has no model directory
    // for those fields.
    describe: async () => undefined,
    // models.dev alone, overrides deliberately NOT applied — a settings view
    // needs to show what an untouched field would inherit.
    automatic: async (model) => capabilitiesFrom(answerFor(options, model)),
    // What is in force: the override first, then models.dev, then nothing.
    capabilities: async (model) => {
      const discovered = capabilitiesFrom(answerFor(options, model));
      if (override === undefined && discovered === undefined) return undefined;
      return resolveCapabilities(override, discovered);
    },
  };
}

/**
 * models.dev's answer for one id, with a line logged the first time an id turns
 * out to be unresolvable.
 *
 * Logged because the failure is otherwise silent in the only place it matters: a
 * model whose modalities cannot be resolved still gets images (see `ImagePolicy`),
 * and if the gateway then drops them the symptom is a model that talks about a
 * picture it was never given, with no explanation anywhere. The line names the
 * model, so the operator knows to declare its modalities by hand.
 */
function answerFor(options: CatalogOptions, model: string): ModelsDevAnswer {
  const index = options.modelsDev;
  if (index === undefined) return { kind: 'absent' };
  const answer = index.answer(model);
  if (answer.kind === 'declared') return answer;
  options.log?.(answer.kind === 'conflict'
    ? `models.dev 各家对「${model}」的输入模态说法不一致：按「未知」处理，图片照发但会附上路径`
    : `models.dev 没有「${model}」这一条：输入模态按「未知」处理，图片照发但会附上路径`);
  return answer;
}

/** The host of an endpoint URL, or undefined when it will not parse. */
function hostOf(baseURL: string): string | undefined {
  try {
    return new URL(baseURL).host;
  } catch {
    return undefined;
  }
}
