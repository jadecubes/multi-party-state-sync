/**
 * The story in README.md ("Alice's empty form", difficulty 2) as code: the
 * hand-written version that went wrong (Before) and the fixed one (After).
 * Illustrative: this repo has no build.
 *
 * Deps: those of create-form-store-helper.ts.
 */
import { useEffect } from 'react'
import isEqual from 'react-fast-compare'
import { useForm, type UseFormReturn } from 'react-hook-form'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createUsePersistFormStoreSync, type FormDTO } from './create-form-store-helper'

interface CampaignFields {
  title: string
  body: string
}

type CampaignDTO = FormDTO<object, CampaignFields>

const defaultCampaign: CampaignDTO = {
  fields: { title: '', body: '' },
  state: {},
}

// Mount one demo at a time: both share this store and its storage key.
const useCampaignStore = create<CampaignDTO>()(
  persist(() => defaultCampaign, {
    name: 'campaign-form',
    storage: createJSONStorage(() => localStorage),
  }),
)

const useCampaignFormSync = createUsePersistFormStoreSync(useCampaignStore)

function CampaignInputs({ form }: { form: UseFormReturn<CampaignFields> }) {
  return (
    <>
      <input {...form.register('title')} />
      <textarea {...form.register('body')} />
    </>
  )
}

// Before: the module's two sync effects, minus the one-time copy on mount.
// The store restored the draft before the store-to-form subscription existed,
// and a subscription only fires on change, so the form stays empty.
export function EmptyFormBefore() {
  const form = useForm<CampaignFields>({ defaultValues: defaultCampaign.fields })
  useEffect(function syncFormToStore() {
    return form.subscribe({
      formState: { values: true },
      callback: ({ values }) => {
        if (isEqual(values, useCampaignStore.getState().fields)) return
        useCampaignStore.setState(prev => ({ ...prev, fields: values }))
      },
    })
  }, [form])
  useEffect(function syncStoreToForm() {
    // Missing: the module first copies the store's current fields into the form.
    return useCampaignStore.subscribe((state) => {
      if (isEqual(form.getValues(), state.fields)) return
      form.reset(state.fields, { keepDirty: true })
    })
  }, [form])
  return <CampaignInputs form={form} />
}

// After: the module copies the store into the form once on mount, then subscribes.
export function EmptyFormAfter() {
  const form = useForm<CampaignFields>({ defaultValues: defaultCampaign.fields })
  useCampaignFormSync(form)
  return <CampaignInputs form={form} />
}
