/**
 * Reference implementation of the hook described in README.md, lifted from a
 * production admin console with the bundling wrappers removed. Two exports:
 *
 *   createUsePersistFormStoreSync  — the four edges (① ② ③ ④) and the difficulty-8 guard
 *   createUseInitPersistForm       — the one-shot initializer for difficulty 5
 *
 * `stampLastEditedAt` is the difficulty-6 flag: it marks store writes that came
 * from a user edit so a rehydrated default is never mistaken for a draft.
 *
 * Dependencies: react, react-hook-form ≥ 7.55 (`subscribe`), zustand ≥ 4 with
 * the persist middleware, react-fast-compare.
 */
import { useEffect, useRef } from 'react'
import isEqual from 'react-fast-compare'
import { type FieldValues, type UseFormReturn } from 'react-hook-form'
import { type StoreApi, type UseBoundStore } from 'zustand'
import { type PersistOptions } from 'zustand/middleware'

// --- minimal shapes; the real types live next to the zustand persist middleware ---

export type Write<T, U> = Omit<T, keyof U> & U

export interface StorePersist<S, Ps> {
  persist: {
    setOptions: (options: Partial<PersistOptions<S, Ps>>) => void
    rehydrate: () => Promise<void> | void
    getOptions: () => Partial<PersistOptions<S, Ps>>
  }
}

/** One store, two halves: `fields` is submitted, `state` is display / bookkeeping only. */
export interface FormDTO<S extends object = object, F extends FieldValues = FieldValues> {
  state: S
  fields: F
}

export interface DraftAwareState {
  lastEditedAt: number | null
}

type PersistedFormStore<TFormDTO extends FormDTO> = UseBoundStore<Write<StoreApi<TFormDTO>, StorePersist<TFormDTO, unknown>>>

/**
 * `stampLastEditedAt: true` opts the sync into writing
 * `state.lastEditedAt = Date.now()` on every user edit. This stamp is how
 * draft-aware forms distinguish a user-made draft from a freshly rehydrated
 * default, so they must enable it; non-draft forms leave it off and keep their
 * `state` slice reference-stable across edits.
 *
 * When `true`, `TFormDTO['state']` must extend `DraftAwareState` — enforced
 * via the conditional constraint on the options type.
 */
export type PersistFormStoreHooksOptions<TFormDTO extends FormDTO> =
  | { stampLastEditedAt?: false }
  | (TFormDTO extends FormDTO<DraftAwareState> ? { stampLastEditedAt: true } : never)

/**
 * Per-call options for `usePersistFormStoreSync`.
 *
 * `skipPersist: true` opts a mount out of writing to / reading from the
 * persisted backing store. Used when the same store name is shared across
 * resources keyed by URL id (e.g. `/edit/:id`) — without this, switching tabs
 * lets one record's persisted draft bleed into another's edit form. The
 * runtime form/store sync still runs, only the localStorage round-trip is
 * suppressed.
 */
export interface UsePersistFormStoreSyncOptions {
  skipPersist?: boolean
}

const noopStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}

export const createUsePersistFormStoreSync = <TFormDTO extends FormDTO>(
  useFormStoreBase: PersistedFormStore<TFormDTO>,
  options: PersistFormStoreHooksOptions<TFormDTO> = {},
) => {
  const { stampLastEditedAt = false } = options
  // Read at hook-creation time. The cleanup uses this to restore the persist
  // middleware's storage; reading getOptions().storage at cleanup time would
  // risk seeing a noop swapped in by another consumer and stranding the store.
  const originalStorage = useFormStoreBase.persist.getOptions().storage
  const storeName = useFormStoreBase.persist.getOptions().name
  let activeMountCount = 0

  // Picked at module-load by NODE_ENV. The selection is a build-time constant
  // (Vite/Webpack inline `process.env.NODE_ENV`), so the unused branch DCEs
  // out of the production bundle entirely — including the useEffect call, the
  // counter mutations, and the error string.
  const useAssertSingleConsumer = process.env.NODE_ENV === 'production'
    ? function useAssertSingleConsumerNoop() {
      // production: assertion stripped — no useEffect registration, no counter work.
    }
    : function useAssertSingleConsumerDev() {
      useEffect(function assertSingleConsumer() {
        activeMountCount += 1
        if (activeMountCount > 1) {
          console.error(
            `[usePersistFormStoreSync] store "${storeName ?? '<unnamed>'}" has ${activeMountCount} consumers mounted; expected 1. `
            + 'Two RHF instances will fight over methods.reset from the store subscription and corrupt each other. '
            + 'Mount this hook at exactly one place per store, or share the form via context.',
          )
        }
        return () => {
          activeMountCount -= 1
        }
      }, [])
    }

  /**
   * Bridges a React Hook Form instance with a zustand persist-backed store.
   *
   * Contract: this hook MUST be called by AT MOST ONE component instance per
   * store. The store is a singleton (created once at module load); two
   * concurrent consumers would race their `methods.reset` and `setState`
   * subscriptions and corrupt each other's RHF state. If you need a second
   * editor for the same data, share the existing one via context or render
   * the existing consumer once at a higher level.
   *
   * Pass `skipPersist: true` for routes where the store name is shared across
   * resources (e.g. `/edit/:id` editing different ids in different tabs) and
   * persistence would let writes bleed across them. This swaps the persist
   * middleware's storage for a noop on mount and restores it on unmount.
   *
   * Call order with `createUseInitPersistForm`: this hook MUST be called
   * BEFORE the init hook in the same component. The storage swap happens in
   * mount-effect order, and the init hook's `setState(formDto, true)` would
   * otherwise hit the real storage and write the formDto through — defeating
   * `skipPersist` for that mount.
   */
  return function usePersistFormStoreSync(
    methods: UseFormReturn<TFormDTO['fields']>,
    syncOptions: UsePersistFormStoreSyncOptions = {},
  ) {
    const { skipPersist = false } = syncOptions

    useAssertSingleConsumer()

    useEffect(function suppressPersistStorage() {
      if (!skipPersist) return
      useFormStoreBase.persist.setOptions({ storage: noopStorage })
      return () => {
        useFormStoreBase.persist.setOptions({ storage: originalStorage })
      }
    }, [skipPersist])

    useEffect(function rehydrateOnTabFocus() {
      if (skipPersist) return
      const updateFormStore = async () => {
        await useFormStoreBase.persist.rehydrate()
        methods.reset(useFormStoreBase.getState().fields, { keepDirty: true, keepErrors: true })
      }
      const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
          updateFormStore()
        }
      }

      window.addEventListener('focus', updateFormStore)
      document.addEventListener('visibilitychange', handleVisibilityChange)
      return () => {
        window.removeEventListener('focus', updateFormStore)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }, [methods, skipPersist])

    useEffect(function syncFormToStore() {
      const unsubscribe = methods.subscribe({
        formState: { values: true },
        callback: ({ values }) => {
          if (isEqual(values, useFormStoreBase.getState().fields)) {
            return
          }
          useFormStoreBase.setState((prev) => {
            if (!stampLastEditedAt) return { ...prev, fields: values }
            // `stampLastEditedAt: true` is only accepted when TFormDTO extends
            // FormDTO<DraftAwareState> (enforced by PersistFormStoreHooksOptions),
            // so prev.state has lastEditedAt; the cast just bridges the runtime flag.
            const stampedState = { ...prev.state, lastEditedAt: Date.now() } as TFormDTO['state']
            return { ...prev, fields: values, state: stampedState }
          })
        },
      })
      return () => {
        unsubscribe()
      }
    }, [methods])

    useEffect(function syncStoreToForm() {
      const saveToForm = (formFields: TFormDTO['fields']) => {
        if (isEqual(methods.getValues(), formFields)) {
          return
        }
        methods.reset(formFields, { keepDirty: true })
      }
      // zustand's subscribe does not fire-on-subscribe, so on mount RHF would
      // stay on its empty defaultValues even if persist had already rehydrated
      // the store synchronously. Pull once here so callers (createUseInitPersistForm)
      // don't have to reset RHF themselves.
      saveToForm(useFormStoreBase.getState().fields)
      const unsubscribe = useFormStoreBase.subscribe((state) => {
        saveToForm(state.fields)
      })
      return () => {
        unsubscribe()
      }
    }, [methods])
  }
}

/**
 * Mount-time initializer for persisted form stores. Decides what the store
 * should hold on entry (remote formDto / default / persisted) and writes it.
 *
 * RHF is **not** touched here. `usePersistFormStoreSync` does an initial pull
 * from the store on mount, plus subscribes for subsequent changes — so any
 * setState we do here propagates to RHF via that sync, and the persisted-no-op
 * branch is also covered by the same initial pull. Callers must mount
 * `usePersistFormStoreSync` alongside this hook.
 *
 * Initialization is **one-shot per mount**: once the first non-undefined
 * `formDto` lands (or the CREATE path resolves), subsequent `formDto`
 * reference changes (e.g., SWR `revalidateOnFocus` returning a fresh
 * object) are ignored. Re-running `setState(formDto, true)` would replace
 * the entire store and discard in-flight user edits.
 */
export const createUseInitPersistForm = <TFormDTO extends FormDTO>(
  useFormStoreBase: PersistedFormStore<TFormDTO>,
  defaultFormStore: TFormDTO,
) => {
  return (options: {
    /**
     * Pre-resolved form DTO. Only the first non-undefined value is applied;
     * later reference changes (e.g. SWR revalidation) are ignored.
     */
    formDto: TFormDTO | undefined
    /**
     * True when the caller is loading a remote source (EDIT mode or CREATE-from-copy)
     * and `formDto` will arrive shortly. While true, we never touch the store on
     * the CREATE path — only the eventual `formDto` apply runs. This avoids
     * misclassifying an in-flight EDIT as a stale CREATE draft.
     */
    expectsFormDto: boolean
    /**
     * CREATE path only (`expectsFormDto: false`): decides whether the persisted store
     * should be discarded and reset to default. Typical case: a persist left over from
     * the previous EDIT session shouldn't surface when the user opens `/create` fresh.
     * Return true to reset to default, false to keep the persisted state. Leave undefined
     * to always keep persisted without running the staleness check.
     */
    isPersistStale?: (persisted: TFormDTO) => boolean
  }) => {
    const { formDto, expectsFormDto, isPersistStale } = options
    const initialFormDtoAppliedRef = useRef(false)

    useEffect(function initPersistFormOnce() {
      if (formDto) {
        if (initialFormDtoAppliedRef.current) return
        initialFormDtoAppliedRef.current = true
        useFormStoreBase.setState(formDto, true)
        return
      }
      if (expectsFormDto) return
      const persisted = useFormStoreBase.getState()
      if (isPersistStale?.(persisted)) {
        useFormStoreBase.setState(defaultFormStore, true)
      }
      // else: keep persisted. syncStoreToForm's initial pull hydrates RHF
      // from the persisted fields on mount, so no explicit RHF reset needed.
    }, [formDto, expectsFormDto, isPersistStale])
  }
}
