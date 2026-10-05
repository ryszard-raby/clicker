# Clickator

Biblioteka przeglądarkowa sterowana promptem, z modelem `jev-1.13.0`. Wynik budowania: **`dist/clickator.js`**, pojedynczy skrypt IIFE bez zależności runtime. Nie tworzy rozszerzenia ani wrappera userscript — można załadować go przez Tampermonkey `@require` i wywołać `Clickator.mount(...)` w tym samym kontekście.

## Budowanie i testy

Node.js 22.13+ (sprawdzone na 24). Sam build nie wymaga instalowania zależności.

```sh
npm run build
npm ci
npm test
```

`demo/index.html` zawiera dziesięć pytań do prób. Testy używają jsdom i atrap JEV, nie zużywają płatnego API. Testy DOM nie zastępują testu w konkretnej przeglądarce i na docelowej stronie.

## Uruchomienie

### Klucz API w `.env`

Skopiuj `.env.example` do `.env` w katalogu projektu i uzupełnij:

```dotenv
TYPESAFE_API_KEY=twoj_klucz_typesafe
```

Po migracji z DefAPI podaj nowy klucz z [konsoli TypeSafe](https://console.typesafe.ai). Stara zmienna `DEFAPI_API_KEY` nie jest odczytywana; nie wystarczy zmienić jej nazwy i zachować poprzedni klucz. Zaktualizuj także nagłówek wrappera Tampermonkey na `@connect api.typesafe.ai`.

Następnie uruchom `npm run build`. `Clickator.mount()` i `Clickator.create()` automatycznie użyją tego klucza; nie trzeba wpisywać go w panelu. Po każdej zmianie `.env` przebuduj skrypt i zaktualizuj kopię ładowaną przez Tampermonkey. Zmienna środowiskowa `TYPESAFE_API_KEY` ma pierwszeństwo przed `.env`. Opcje `apiKey` i `getApiKey` przekazane podczas uruchamiania mają pierwszeństwo przed kluczem z buildu. Bez klucza build nadal działa i można podać go w panelu.

Przeglądarka nie czyta lokalnego `.env`: build **osadza klucz w wynikowym JS**. `.env` i `dist/` są ignorowane przez Git; nie publikuj bundla z kluczem ani nie udostępniaj go przez publiczny URL. Ignorowanie nie usuwa plików już śledzonych przez Git.

Po załadowaniu bundla:

```js
const runner = Clickator.mount();
```

Panel pozwala podać prompt, klucz TypeSafe, tryb, limit czasu/kroków i warunek sukcesu. Klucz wpisany w panelu pozostaje w pamięci bieżącej strony. Domyślny transport to `fetch`; jeżeli TypeSafe lub CSP strony blokuje połączenie, użyj adaptera Tampermonkey.

### Połączenie z własnym skryptem Tampermonkey

We własnym nagłówku ustaw `@require` na prywatnie dostępny adres zbudowanego pliku, `@run-at document-idle`, `@noframes`, `@connect api.typesafe.ai` oraz granty: `GM_xmlhttpRequest`, `GM_getTab`, `GM_saveTab`. Dopasowania `@match` muszą obejmować strony, po których agent ma nawigować. Przykład używa klucza z `.env` osadzonego podczas budowania:

```js
Clickator.mount({
  transport: Clickator.gmTransport(GM_xmlhttpRequest),
  store: Clickator.gmTabStore(GM_getTab, GM_saveTab),
  autoResume: true, // domyślnie włączone
});
```

Alternatywnie możesz przekazać `getApiKey: () => GM_getValue('typesafeKey', '')` i ustawić klucz we własnym wrapperze przez `GM_setValue` (wymaga grantów `GM_getValue` i `GM_setValue`). `GM_getTab`/`GM_saveTab` zachowują sesję osobno dla każdej karty, również przy przejściu na inną domenę. Adapter czeka na zapis przed kliknięciem. API adapterów opiera się na [dokumentacji Tampermonkey](https://www.tampermonkey.net/documentation.php).

Panel automatycznie używa dostępnych `GM_getTab`/`GM_saveTab` i `GM_xmlhttpRequest`, jeśli nie podano własnych adapterów. Bez adaptera zapisu używany jest `sessionStorage`: wznowienie działa w obrębie tej samej domeny i karty. Bez stałego dostawcy klucza panel po przeładowaniu wymaga jego ponownego podania i kliknięcia „Wznów”. `autoResume` domyślnie jest włączone; `autoResume: false` przywraca ręczne wznawianie. Zapis nie zawiera klucza API, ale zawiera prompt, historię i ostatnie stany strony służące wykrywaniu pętli. Stop usuwa zapis. Wznowienie zachowuje pierwotny czas startu i licznik kroków; nie odnawia limitów.

### API bez panelu

```js
const runner = Clickator.create({
  apiKey: 'KLUCZ_Z_TWOJEJ_KONFIGURACJI',
  // transport, getApiKey, store: jak powyżej
  onStatus: message => console.log(message),
  confirm: async action => window.confirm(`Wykonać: ${action.label}?`),
});

await runner.start({
  goal: 'Rozwiąż wszystkie pytania quizu i sprawdź odpowiedzi.',
  mode: 'yolo', // domyślnie; albo 'manual'
  maxSteps: 40,
  maxMinutes: 5,
  confidence: 0.2,
  settleMs: 650,
  success: { type: 'text', value: 'Wynik: 10/10' },
});
// Z innego handlera, także podczas oczekiwania na API lub zgodę:
// await runner.stop();
// await runner.resume();
// console.log(Clickator.scan());
```

`start()` kończy się po zakończeniu/zatrzymaniu sesji. `transport(body, {apiKey, signal})` ma zwracać sparsowany JSON odpowiedzi TypeSafe. `store` implementuje asynchroniczne `load()`, `save(state)` i `clear()`. `confirm(action)` zwraca boolean lub Promise<boolean>. Błędy działania są raportowane przez `onStatus`; błędy konfiguracji odrzucają Promise `start()`.

## Jak działa podejmowanie decyzji

### Text generation: direct OpenAI API

JEV uses the official TypeSafe API directly. Text input generation uses **gpt-5.6-luna** directly through **https://api.openai.com/v1/chat/completions**, with a separate OpenAI key. See the [official model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Configure both keys in .env, then rebuild:

```dotenv
TYPESAFE_API_KEY=your_typesafe_key
OPENAI_API_KEY=your_openai_key
```

Run `npm run build` and update the userscript. The Tampermonkey wrapper needs both `@connect api.typesafe.ai` and `@connect api.openai.com`. Both keys are embedded in the private bundle. The panel also accepts an OpenAI key in memory; the programmatic alternatives are `openaiApiKey` or `getOpenAIKey`. A missing OpenAI key stops text generation; the TypeSafe key is never used as a fallback.

Luna receives only the goal, field label (up to 160 characters), and maximum length. The response uses a strict JSON schema with a string-or-null value and `store: false`. Refusals, incomplete responses, invalid JSON, and invalid values stop execution. Filling and submitting remain separate JEV actions; manual mode requires approval of the exact generated value. Logging, Stop, and stale-DOM checks still apply.

Custom transports receive the selected provider's key in `apiKey`. Route model `gpt-5.6-luna` with its `messages` and `response_format` to OpenAI, and JEV to TypeSafe. Both request bodies are sent unchanged. Local tests cover routing, credentials, parsing, and the fill/search flow; live OpenAI verification requires OPENAI_API_KEY.

### Logi requestów i odpowiedzi JEV

Konsola przeglądarki pokazuje `[Clickator build]` z datą buildu i modelem tekstowym oraz `[Clickator API]` dla żądań, odpowiedzi HTTP, sparsowanych odpowiedzi i błędów. Wpisy zawierają identyfikator sesji i requestu, etap, model, endpoint, rozmiar body, czas, status HTTP oraz dostępne identyfikatory odpowiedzi serwera. Body i odpowiedzi mogą zawierać dane strony; nagłówki autoryzacji nie są logowane, a wartość używanego klucza jest maskowana. Wyłączenie: `Clickator.mount({ debug: false })` (nie wyłącza informacji o buildzie). Własny transport może przekazać status przez `onHttp({status, response, requestId})` w drugim argumencie.

Jeśli log requestu wskazuje Lunę, a `[Clickator build]` nie wskazuje Luna, sprawdź ładowaną kopię `@require` i zapisz ponownie userscript w Tampermonkey po przebudowaniu pliku. Włącz „Preserve log” w DevTools, aby zachować wpisy podczas nawigacji.

W panelu kliknij **Wybierz folder logów** i zaakceptuj dostęp do zapisu. Skrypt utworzy w wybranym miejscu podfolder `clickator-logs`. Dopóki nie wybierzesz folderu, zapis jest wyłączony.

Każde wywołanie API zapisuje dwa pliki: `request-1.json` i `response-1.json`, potem `request-2.json` i `response-2.json` itd. Numer oznacza wywołanie JEV, nie wykonaną akcję: zapis obejmuje też niską pewność, ponowne odczyty zmienionej strony i potwierdzanie sukcesu. Request zawiera wysłane body JSON (prompt, kontekst, historię i kryteria); response zawiera całą sparsowaną odpowiedź przed walidacją decyzji. Nie zapisujemy nagłówków autoryzacji ani konfiguracji klucza API.

**Każdy Start zeruje numerację i nadpisuje te same ścieżki.** Istniejące numerowane pliki najpierw otrzymują `status: not_requested_in_current_session`, aby wyższe numery z dłuższej poprzedniej sesji nie wyglądały jak bieżące wyniki. Przed wysłaniem requestu jego response ma `status: pending`; po otrzymaniu wyniku zostaje zastąpiony odpowiedzią. Błąd lub przerwanie zapisuje `status: error` i komunikat, a błąd HTTP / niepoprawny JSON także surową treść odpowiedzi, jeśli jest dostępna. Zamknięcie strony podczas żądania może pozostawić `pending`.

**Wznów zachowuje numerację.** Po przeładowaniu panel kontynuuje zadanie bez zapisu do folderu, jeśli logger nie jest dostępny — uchwyt folderu nie jest przechowywany. Panel informuje o wyłączeniu logów. Aby ponownie zapisywać logi, zatrzymaj zadanie i wybierz folder. Własny logger przekazywany przy każdym montowaniu panelu pozwala zachować logowanie. Bezpośrednie `runner.resume()` nadal wymaga loggera dla sesji z logowaniem; `runner.resume({ allowMissingLogger: true })` pozwala kontynuować bez niego. W obrębie jednej strony kolejne Start używają tego samego folderu. Nie używaj jednego folderu dla równocześnie działających kart, bo będą nadpisywać te same pliki.

Zapis wymaga obsługi File System Access API, bezpiecznego kontekstu i gestu użytkownika; [dokumentacja Chrome](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) opisuje wymagania. Jeśli API nie jest dostępne w przeglądarce lub sandboxie Tampermonkey, panel wyświetli komunikat. Można wtedy przekazać własny adapter przez `Clickator.mount({ logger })` lub `Clickator.create({ logger })`: asynchroniczne `reset()` rozpoczyna nową sesję, a `write(filename, value)` zapisuje JSON. Błąd zapisu zatrzymuje sesję, aby nie wykonywać akcji bez logu. Logi mogą zawierać tekst i dane widoczne na stronie; folder `clickator-logs/` jest ignorowany przez Git.

Testy używają atrapy systemu plików; zapis przez okno wyboru folderu wymaga sprawdzenia w docelowej przeglądarce.

### Pętla decyzji

1. Skanowanie dostępnych buttonów, linków, checkboxów, radio, selectów i podstawowych interaktywnych ról ARIA. Etykiety pochodzą m.in. z `label`, `aria-label`, `aria-labelledby`, tekstu i tytułów.
2. Grupowanie: preferowane `fieldset`, grupy ARIA i kontenery semantyczne. W pozostałych przypadkach wyszukiwany jest najbliższy wspólny rodzic kontrolek; rodzic obejmujący pytanie jest dołączany, gdy nie dodaje nowych kontrolek. Każda akcja zawiera ID swojej grupy, której tekst trafia do modelu. To heurystyka, nie gwarancja dla dowolnego HTML.
3. Pierwsze żądanie (`state.stage: component`) podaje krótkie opisy komponentów, zaznaczenia, liczbę i rodzaje akcji — bez listy wszystkich akcji. JEV wybiera ID komponentu (`g…`), `done` albo `blocked`. Opis komponentu ma do 320 znaków, przegląd strony do 1200, a historia obejmuje osiem ostatnich akcji. Komponenty bez dostępnych akcji są widoczne jako kontekst, ale nie można ich wybrać.
4. Drugie żądanie (`state.stage: action`) przekazuje pełny kontekst tylko wybranego komponentu oraz wyłącznie jego akcje. JEV wybiera ID akcji (`a…`) albo `blocked`. Nie może wybrać akcji innego komponentu ani zakończyć całego celu na podstawie tego lokalnego widoku. Integracja używa pytań `next: choice`, `achieved: noul`, endpointu `POST https://api.typesafe.ai/v1/systemone` i Bearer auth zgodnie z [dokumentacją JEV](https://docs.typesafe.ai/api).
5. Sprawdzenie aktualności DOM po każdym etapie, pewności obu wyborów i ewentualnej zgody. Wykonanie **jednej** akcji, odczekanie i ponowny skan. Jeśli którykolwiek wybór jest poniżej progu, manualny pyta o zgodę na konkretną akcję, a YOLO zatrzymuje się. Limit kroków nadal liczy wykonane akcje, natomiast logi numerują osobno każde wywołanie API.

### Wyskakujące okna

Skaner daje pierwszeństwo widocznym `dialog[open]`, `[role="dialog"]`, `[role="alertdialog"]` i `[aria-modal="true"]`. W aktywnym oknie wybiera jego kontrolki oraz elementy powiązane przez `aria-controls` / `aria-owns` (np. listę rozwijaną renderowaną poza oknem). Ograniczenie do 320 kontrolek stosuje dopiero po tym zawężeniu. Po zamknięciu okna wraca do pozostałej strony. JEV otrzymuje także opis `activeDialog`.

Dla kontrolek w obszarze ekranu skaner sprawdza zasłonięcie przez `elementsFromPoint`; własny pasek Clickatora jest pomijany. Tuż przed wykonaniem ponownie sprawdza dostępność elementu i aktywne okno. Wykrycie nakładki w tym ostatnim momencie zatrzymuje zadanie zamiast klikać pod nią. Kontrolki poza ekranem pozostają dostępne w aktualnym obszarze działania.

Po akcji `MutationObserver` wydłuża oczekiwanie, aż przez 200 ms nie będzie zmian DOM, z zachowaniem minimum `settleMs` (dla wpisywania także `autocompleteMs`). Oczekiwanie kończy się najpóźniej po większej z wartości: ustawione minimum lub 2 sekundy. Stop przerywa je natychmiast. To nie gwarantuje wykrycia popupu, który pojawi się dopiero po zakończeniu oczekiwania; dalsze skany nadal sprawdzają aktualność decyzji. Okna bez semantycznego oznaczenia nie mają gwarantowanego pierwszeństwa, a animacje samego CSS nie wywołują obserwatora. Testy lokalne symulują popupy i zasłonięcia; zachowanie konkretnej strony wymaga weryfikacji w przeglądarce.

### Filtry i kolejność komponentów

Nie utrzymujemy sztywnej kolejki ID komponentów: identyfikatory obowiązują dla bieżącego skanu. Po zaznaczeniu filtra następuje nowy wybór komponentu na podstawie aktualnego stanu i historii (z opisem poprzedniego komponentu). Model może wybrać kolejny filtr, a następnie komponent zawierający przycisk „Filtruj”. Instrukcja dla JEV wskazuje, że samo zaznaczenie pól nie dowodzi zastosowania filtrów. Mały formularz może stanowić jeden komponent; jego fieldsety lub grupy ARIA mogą tworzyć osobne komponenty. Kolejne wybory pozwalają pracować wielokrotnie w tym samym komponencie.

Zwykle oznacza to dwa requesty na akcję, lecz mniejsze listy wyboru. Nie gwarantuje mniejszej sumarycznej liczby tokenów ani bezbłędnego planowania przez model. Log `request-N.json` zawiera `state.stage`, aby łatwo odróżnić oba etapy.

Tryb **manualny** bez pytania zmienia checkboxy (także odznacza), radio i role checkbox/radio/switch, jeśli decyzja osiąga ustawiony próg pewności. Poniżej progu także te akcje wymagają zgody, z pokazaniem kontekstu i pewności. Przyciski, linki i wybór opcji select zawsze wymagają zgody. Zmiana checkboxa może uruchomić handlery strony i spowodować nawigację — manualny nie izoluje skutków zdarzeń. **YOLO** wykonuje akcje bez zgody, jeśli osiągają próg; poniżej niego zatrzymuje sesję.

### Niska pewność decyzji

Domyślny tryb to YOLO, a próg pewności wynosi 20%. W panelu pole „Minimalna pewność decyzji (%)” pozwala zmienić próg — decyzja równa progowi jest akceptowana. Zmiana obowiązuje po kliknięciu Start; Wznów używa konfiguracji zapisanej sesji. W API domyślnej wartości odpowiada `runner.start({ goal: '...', confidence: 0.2 })`.

Niższy próg dopuszcza mniej pewne wybory. Zamiast obniżać go dla wszystkich działań, możesz użyć trybu manualnego i zatwierdzać pojedyncze niepewne akcje. Ta zgoda nie obniża progu następnych decyzji ani nie omija sprawdzania aktualności DOM. Niepewne `done`/`blocked` nadal zatrzymuje sesję; completion uses the same confidence setting. Wynik pewności modelu nie jest gwarancją poprawności akcji.

## Zakończenie

Najbardziej przewidywalny jest jawny warunek `success`:

- `text`: zebrany widoczny tekst zawiera podany fragment;
- `url`: bieżący pełny URL zawiera podany fragment;
- `selector`: selektor CSS wskazuje widoczny element (np. `.quiz-result.success`).

Warunek sprawdzany jest przed kolejnym wywołaniem API. Jeśli go podasz, model nie może zastąpić go własnym werdyktem. Wartość musi jednoznacznie oznaczać sukces; sam napis przycisku „Zakończ” nie jest dobrym warunkiem.

Bez jawnego warunku wymagane są dwie kolejne decyzje `done` z `achieved >= confidence` i wystarczającą pewnością wyboru. Jest to heurystyczna ocena modelu, **nie dowód** poprawnego wykonania; dwa odczyty nie są niezależną weryfikacją. Komunikat panelu rozróżnia tę ocenę od spełnienia jawnego warunku.

Inne zakończenia nie oznaczają sukcesu: limit kroków/czasu, niska pewność, `blocked`, błąd API, dwie akcje bez zmiany obserwowanego stanu, powtarzana akcja w tym samym stanie, pięć nieaktualnych odpowiedzi z rzędu, odmowa lub Stop. Domyślne limity: 40 akcji i 5 minut; timeout żądania: 30 sekund. Błędy API nie uruchamiają automatycznych ponowień.

## Zakres MVP

Planowanie jest domyślnie włączone. Po Start JEV klasyfikuje polecenie jako proste lub złożone. Proste trafia do dotychczasowej pętli wyboru komponentu i akcji. Dla złożonego Luna (`OPENAI_API_KEY`) tworzy kolejkę 1–8 samodzielnie opisanych podcelów, każdy z widocznym warunkiem ukończenia. JEV wykonuje je sekwencyjnie tym samym mechanizmem; dwa potwierdzenia `done` kończą aktualny podcel. Panel pokazuje numer i treść bieżącego zadania.

Kolejka, pozycja, ukończone cele i licznik ponownych planowań zapisują się w sesji i przechodzą przez nawigację razem z dotychczasowym magazynem Tampermonkey. Decyzja JEV `blocked` uruchamia ponowne planowanie pozostałych celów (maksymalnie dwie próby na całą sesję), także gdy zadanie pierwotnie uznano za proste. Planista otrzymuje oryginalne polecenie, ukończone i pozostałe cele, krótki kontekst strony oraz ostatnie akcje. Błędy API, niska pewność i zabezpieczenia przed zapętleniem nadal zatrzymują wykonanie.

Limity czasu i akcji obejmują cały proces i nie resetują się między podcelami. Jawny `success` pozostaje warunkiem sukcesu całego polecenia. Wszystkie wywołania klasyfikacji i planowania korzystają z dotychczasowych numerowanych logów request/response. `Clickator.mount({ planning: false })` lub `Clickator.create({ planning: false })` wyłącza tę warstwę. Planista używa [Structured Outputs OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs); odpowiedź jest dodatkowo walidowana lokalnie. Testy używają atrap API — rzeczywiste plany zależą od odpowiedzi modeli.

Dropdowny: natywne `select` oferują konkretne opcje (także zaznaczanie/odznaczanie w `multiple`). Niestandardowe kontrolki z `role=combobox` lub `aria-haspopup=listbox/menu/true` oferują otwarcie/zamknięcie, a po ponownym skanie JEV wybiera widoczną opcję `role=option` lub `menuitem*`. `aria-controls` / `aria-owns` łączy listę renderowaną poza kontrolką z jej etykietą, np. „Rozmiar”. Opcje ukryte i wyłączone są pomijane. W trybie manualnym otwarcie i wybór wymagają zgody. Dowolne dropdowny z samych divów bez ról ARIA, listy wirtualizowane i wyszukiwanie tekstowe wewnątrz comboboxa mogą wymagać adaptera konkretnej strony.

- Standardowy DOM głównego dokumentu; brak obsługi iframe, shadow DOM stron, canvas, drag-and-drop i zdarzeń wymagających `isTrusted`.
- Generuje tekst dla pól text/search przez Lunę. Nie obsługuje textarea, contenteditable, pól password/email/number ani uploadu; pola readonly są pomijane.
- Skan obejmuje do 320 kontrolek i 240 akcji na komponent; lokalnie zbierany tekst strony do 10 000 znaków, grupy do 1600. Do JEV trafiają ograniczone widoki opisane powyżej. Duże formularze mogą wymagać zawężenia skanowania. Panel sygnalizuje skrócenie listy. Warunek tekstowy dotyczy lokalnie zebranego fragmentu tekstu; dla długich stron użyj selektora.
- Okres oczekiwania po akcji jest konfigurowalny; wolno aktualizujące się aplikacje mogą wymagać większego `settleMs`. Stale zmieniający się tekst może uniemożliwić wykonanie decyzji.
- Linki otwierane są w tej samej karcie; popupów otwieranych kodem strony nie przejmuje. Pełna nawigacja wymaga uruchomienia wrappera także na stronie docelowej. Bez niego kontynuacja nie nastąpi.
- Tekst strony, opisy kontrolek i wartości obsługiwanych pól text/search trafiają do TypeSafe i włączonych logów. Hasła oraz pliki nie są pobierane. Tekst strony jest oznaczany jako niezaufany, ale prompt nie gwarantuje odporności na prompt injection. Nie przekazuj klucza do kontekstu JS strony; preferuj sandbox Tampermonkey.
- Nie wykonano wywołania płatnego JEV ani testu integracyjnego w Tampermonkey — potrzebny jest klucz i docelowa strona. Schemat API zweryfikowano w dokumentacji, wykonanie i scenariusze zatrzymania sprawdzono lokalnymi testami.

### Automatyczne przejście z kategorii do koszyka

Wrapper Tampermonkey musi uruchamiać `Clickator.mount()` na każdej stronie zadania (`@match` obejmujący kategorię, produkt i koszyk; `@run-at document-idle`). Klucz z buildu lub `getApiKey` musi być dostępny po przeładowaniu. W trybie YOLO zadanie np. „Znajdź Samsung S26 i dodaj go do koszyka” kontynuuje się po nawigacji z tą samą historią i pozostałym budżetem kroków/czasu. Tryb manualny wznawia analizę, ale nadal wymaga potwierdzenia kliknięć. Samo dodanie do koszyka nie oznacza złożenia zamówienia.


JEV uses the configured confidence threshold for both intermediate and final completion (two consecutive done decisions). Luna only plans tasks and generates field values. Legacy successThreshold/taskSuccessThreshold values in saved sessions are ignored.

