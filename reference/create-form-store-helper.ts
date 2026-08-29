/**
 * Production version of the hook in README.md, bundling wrappers removed.
 *
 *   createUsePersistFormStoreSync  — edges ① ② ③ ④, difficulty-8 guard
 *   createUseInitPersistForm       — one-shot initializer, difficulties 5 and 6
 *
 * `stampLastEditedAt` records when the user last edited, for display; it is not
 * how drafts are detected.
 *
 * Deps: react, react-hook-form ≥ 7.55, zustand ≥ 4 (persist), react-fast-compare.
 */
import { useEffect, useRef } from 'react'
import isEqual from 'react-fast-compare'
import { type FieldValues, type UseFormReturn } from 'react-hook-form'
import { type StoreApi, type UseBoundStore } from 'zustand'
import { type PersistOptions } from 'zustand/middleware'

export type Write<T, U> = Omit<T, keyof U> & U

export interface StorePersist<S, Ps> {
  persist: {
    setOptions: (options: Partial<PersistOptions<S, Ps>>) => void
    rehydrate: () => Promise<void> | void
    getOptions: () => Partial<PersistOptions<S, Ps>>
  }
}

/** `fields` is submitted; `state` is display and bookkeeping. */
export interface FormDTO<S extends object = object, F extends FieldValues = FieldValues> {
  state: S
  fields: F
}

export interface DraftAwareState {
  lastEditedAt: number | null
}

type PersistedFormStore<TFormDTO extends FormDTO> = UseBoundStore<Write<StoreApi<TFormDTO>, StorePersist<TFormDTO, unknown>>>

/** `stampLastEditedAt` requires a `DraftAwareState` — the conditional type enforces it. */
export type PersistFormStoreHooksOptions<TFormDTO extends FormDTO> =
  | { stampLastEditedAt?: false }
  | (TFormDTO extends FormDTO<DraftAwareState> ? { stampLastEditedAt: true } : never)

export interface UsePersistFormStoreSyncOptions {
  /** Suppress ③ and ④ for this mount. Sync ① ② keeps running. */
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
  // Captured here, not at cleanup — at cleanup it could be another consumer's noop.
  const originalStorage = useFormStoreBase.persist.getOptions().storage
  const storeName = useFormStoreBase.persist.getOptions().name
  let activeMountCount = 0

  // NODE_ENV is a build-time constant, so the dev branch is dead code in prod.
  const useAssertSingleConsumer = process.env.NODE_ENV === 'production'
    ? function useAssertSingleConsumerNoop() {}
    : function useAssertSingleConsumerDev() {
      useEffect(function assertSingleConsumer() {
        activeMountCount += 1
        if (activeMountCount > 1) {
          console.error(
            `[usePersistFormStoreSync] store "${storeName ?? '<unnamed>'}" has ${activeMountCount} consumers mounted; expected 1. `
            + 'Two RHF instances will fight over methods.reset. Mount once per store, or share the form via context.',
          )
        }
        return () => {
          activeMountCount -= 1
        }
      }, [])
    }

  /**
   * Call before `createUseInitPersistForm`'s hook in the same component:
   * effects run in order, and the init hook's `setState` must land after
   * the storage swap or `skipPersist` writes the record through anyway.
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
            // The options type guarantees `state` has `lastEditedAt` when the flag is on.
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
      // subscribe is change-only; the store may already hold the draft.
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
 * Decides what the store holds on mount: remote `formDto`, persisted draft, or default.
 * Never touches RHF — `syncStoreToForm`'s mount pull delivers whatever is written here.
 */
export const createUseInitPersistForm = <TFormDTO extends FormDTO>(
  useFormStoreBase: PersistedFormStore<TFormDTO>,
  defaultFormStore: TFormDTO,
) => {
  return (options: {
    /** Applied once; later references (e.g. SWR revalidation) are ignored. */
    formDto: TFormDTO | undefined
    /** A remote `formDto` is on its way — leave the store alone until it lands. */
    expectsFormDto: boolean
    /** Create path only: return true to discard the persisted store (e.g. a leftover edit draft). */
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
      if (isPersistStale?.(useFormStoreBase.getState())) {
        useFormStoreBase.setState(defaultFormStore, true)
      }
    }, [formDto, expectsFormDto, isPersistStale])
  }
}
