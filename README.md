# Eight Questions About Form State

Each question is something a product actually asked for. Each answer is one statement and one diagram.

The architecture all eight land on:

```mermaid
flowchart LR
    D["Dialogs · services<br/>outside the form tree"]
    F["Form library<br/>validation · isDirty"]
    S["<b>Store</b><br/>fields + state"]
    P["Persistent storage"]
    U["Components"]

    D -- "⓪" --> S
    F -- "①" --> S
    S -- "②" --> F
    S -- "③" --> P
    P -- "④" --> S
    S -- "⑤" --> U

    style S fill:#2d6a4f,color:#fff
```

⓪ direct write · ① values change · ② `reset(fields)` · ③ automatic persist · ④ `rehydrate()` on focus · ⑤ selector subscription

---

## How does a user get their half-finished form back two days later?

Every keystroke writes to the store, and the persistence middleware writes after every store mutation. Two days later the store hydrates **before React renders** — so the form has to pull from it once at mount, because change-only subscriptions will never fire for a value that was already there.

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant F as Form
    participant S as Store
    participant P as Storage

    U->>F: types
    F->>S: ①
    S->>P: ③ automatic
    U->>U: closes the tab

    Note over P,S: two days later
    P->>S: hydrates at module load
    Note over F: form starts on empty defaults
    S->>F: ② manual pull at mount
    F-->>U: fields restored
```

> Delete that one-line pull and the form shows empty defaults over a perfectly good draft. It looks redundant in review.

---

## How does a dialog at the app root write into a field it can't reach?

It doesn't reach the field. It writes the store, and the store→form edge delivers it.

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant D as Dialog
    participant S as Store
    participant F as Form

    U->>D: picks a value, confirms
    D->>S: ⓪ direct write
    S->>F: ②
    F-->>U: field updates
    F->>S: ① echo
    Note over S: equality guard → stop
```

---

## How do you display the name of an item that no longer exists?

Store the shape the user selected, at selection time, next to the fields. It is not a form field — it is never submitted — so the store keeps a second half for exactly this.

```mermaid
flowchart LR
    subgraph DTO["one store, two halves"]
      A["<b>fields</b><br/>itemId: 4471<br/><i>submitted</i>"]
      B["<b>state</b><br/>snapshot: name, thumbnail<br/><i>display only</i>"]
    end
    A --> F["② → form field"]
    B --> N["⑤ → name on screen"]
```

> The option list is fetched fresh. A delisted item is gone from it, and the draft would render a bare id.

---

## When a parent changes, how do four dependent values change without a visible intermediate state?

One `setState` writes all four in the same tick — two ids in `fields`, two snapshots in `state`.

```ts
store.setState(prev => ({
  ...prev,
  fields: { ...prev.fields, parentId: next.id, childId: null },
  state:  { ...prev.state, parentSnapshot: next, childSnapshot: null },
}))
```

```mermaid
sequenceDiagram
    autonumber
    participant V as service
    participant S as Store
    participant F as Form
    participant N as Name display

    V->>S: ⓪ one setState, four keys
    S->>F: ② both ids together
    S->>N: ⑤ both snapshots together
```

> Four separate writes are four separate renders — the old child's name beside the new parent's id.

---

## How does one section of an eight-section form re-render without the other seven?

Read through a store selector, not the form library's `watch()`.

```mermaid
flowchart TB
    T["user types in section A"]
    T --> W["watch()"] --> WR["A re-renders<br/>B–H re-render too"]
    T --> SE["store selector"] --> SR["A re-renders<br/><b>B–H untouched</b>"]

    style SR fill:#2d6a4f,color:#fff
```

> `watch()` re-renders the whole subscribed subtree on any field change. A selector fires only for its own value.

---

## How do you lock fields on the server's original answer after the user has already toggled it?

Keep the server's answer in the `state` half, where the user's toggle cannot reach it.

```ts
useFormStoreSelector(s => s.state.initialStatus === STATUS.ACTIVE)
```

```mermaid
sequenceDiagram
    autonumber
    participant API as Server
    participant S as Store
    actor U as User
    participant L as Lock logic

    API->>S: ⓪ state.initialStatus = ACTIVE
    S->>L: ⑤
    L-->>U: fields locked
    U->>S: toggles state.status → disabled
    Note over S: initialStatus untouched
    S->>L: ⑤
    L-->>U: still locked
```

---

## How does a second tab learn that the first tab edited the same record?

It doesn't, until it regains focus and reads storage on purpose. Persistence middleware hydrates once at creation and ignores the browser's `storage` event.

```mermaid
sequenceDiagram
    autonumber
    participant A as Tab A
    participant P as localStorage
    actor U as User
    participant B as Tab B

    A->>P: ③
    Note over B: Tab B has no idea
    U->>B: switches back
    B->>P: ④ rehydrate() on focus
    P-->>B: whole store replaced
    B-->>U: form shows tab A's content
```

> If the key is one constant and the route is `/record/:id/edit`, this is how one record's content lands in another record's form.

---

## Why doesn't the unsaved-changes warning fire when a dialog changed the value?

Because edge ② uses `reset(fields, { keepDirty: true })` as a transport, and `keepDirty` preserves an existing `true` — it never turns `false` into `true`.

```mermaid
flowchart TB
    T1["user types"] --> D1["isDirty → true"] --> W1["warns"]
    T2["dialog writes store"] --> R["② reset with keepDirty"] --> D2["isDirty stays false"] --> W2["<b>no warning</b>"]

    style W2 fill:#9c2e46,color:#fff
```

> Compensated with a second signal: `isDirty || hasDraft`. In edit mode `hasDraft` is true from page load, so it over-warns. That was accepted as the safer failure.

---

## What the eight answers add up to

| Question | ⓪ | ① | ② | ③ | ④ | ⑤ |
|---|---|---|---|---|---|---|
| 1 · Draft after two days | | ● | ● | ● | | |
| 2 · Dialog writes a field | ● | ● | ● | | | |
| 3 · Name of a deleted item | ● | | ● | | | ● |
| 4 · Four values, one tick | ● | | ● | | | ● |
| 5 · One section re-renders | | ● | | | | ● |
| 6 · Lock on the original answer | ● | | | | | ● |
| 7 · Two tabs | | | ● | ● | ● | |
| 8 · Warning misses an edit | ● | ● | ● | | | |

**Only questions 1 and 7 need persistence.** The other six are answered by two parties.

**Edge ⑤ answers four of them — more than persistence does.** The store's job is less "mirror the form" than "hold what the form has no room for": snapshots that outlive their option list, the server's original answer, per-value subscriptions.

---

## The mechanism

Edges ① and ② are opposite subscriptions, each opening with the same guard:

```ts
// ① form → store
form.subscribe({ values: true }, values => {
  if (deepEqual(values, store.getState().fields)) return
  store.setState(prev => ({ ...prev, fields: values }))
})

// ② store → form
store.subscribe(state => {
  if (deepEqual(form.getValues(), state.fields)) return
  form.reset(state.fields, { keepDirty: true })
})
```

Value equality, not provenance. Neither side remembers whose write it was; each refuses to act when there is nothing to do. The cycle terminates after one bounce in both directions.

③ is free. ④ is the focus listener. ⑤ needs no synchronization at all, which is why it answers the most questions.

---

## What it cost

Twenty forms used this. Eight persisted to `localStorage` behind `/record/:id/edit` with one shared key, and needed an opt-in flag to suppress persistence in edit mode.

**Five of the eight passed it. Three did not** — same route shape, same key, same factory. It compiled, because the option is optional. It passed review, because a missing argument is invisible. It worked in every single-tab test, because the bug needs two tabs on two records.

> A correctness property that depends on every call site opting in will be violated in proportion to the number of call sites.

Make the suppression structural — decided by the factory, not the page — and the flag, its ordering contract, and all three bugs stop existing at once.
