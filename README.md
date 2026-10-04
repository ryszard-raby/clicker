# Clickator

Biblioteka przeglądarkowa sterowana promptem, z modelem `typesafe/jev-1.13`. Wynik budowania: **`dist/clickator.js`**, pojedynczy skrypt IIFE bez zależności runtime. Nie tworzy rozszerzenia ani wrappera userscript — można załadować go przez Tampermonkey `@require` i wywołać `Clickator.mount(...)` w tym samym kontekście.

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
DEFAPI_API_KEY=twoj_klucz_defapi
```

Następnie uruchom `npm run build`. `Clickator.mount()` i `Clickator.create()` automatycznie użyją tego klucza; nie trzeba wpisywać go w panelu. Po każdej zmianie `.env` przebuduj skrypt i zaktualizuj kopię ładowaną przez Tampermonkey. Zmienna środowiskowa `DEFAPI_API_KEY` ma pierwszeństwo przed `.env`. Opcje `apiKey` i `getApiKey` przekazane podczas uruchamiania mają pierwszeństwo przed kluczem z buildu. Bez klucza build nadal działa i można podać go w panelu.

Przeglądarka nie czyta lokalnego `.env`: build **osadza klucz w wynikowym JS**. `.env` i `dist/` są ignorowane przez Git; nie publikuj bundla z kluczem ani nie udostępniaj go przez publiczny URL. Ignorowanie nie usuwa plików już śledzonych przez Git.

Po załadowaniu bundla:

```js
const runner = Clickator.mount();
```

Panel pozwala podać prompt, klucz DefAPI, tryb, limit czasu/kroków i warunek sukcesu. Klucz wpisany w panelu pozostaje w pamięci bieżącej strony. Domyślny transport to `fetch`; jeżeli DefAPI lub CSP strony blokuje połączenie, użyj adaptera Tampermonkey.

### Połączenie z własnym skryptem Tampermonkey

We własnym nagłówku ustaw `@require` na prywatnie dostępny adres zbudowanego pliku, `@run-at document-idle`, `@noframes`, `@connect api.defapi.org` oraz granty: `GM_xmlhttpRequest`, `GM_getTab`, `GM_saveTab`. Dopasowania `@match` muszą obejmować strony, po których agent ma nawigować. Przykład używa klucza z `.env` osadzonego podczas budowania:

```js
Clickator.mount({
  transport: Clickator.gmTransport(GM_xmlhttpRequest),
  store: Clickator.gmTabStore(GM_getTab, GM_saveTab),
  autoResume: true, // domyślnie włączone
});
```

Alternatywnie możesz przekazać `getApiKey: () => GM_getValue('defapiKey', '')` i ustawić klucz we własnym wrapperze przez `GM_setValue` (wymaga grantów `GM_getValue` i `GM_setValue`). `GM_getTab`/`GM_saveTab` zachowują sesję osobno dla każdej karty, również przy przejściu na inną domenę. Adapter czeka na zapis przed kliknięciem. API adapterów opiera się na [dokumentacji Tampermonkey](https://www.tampermonkey.net/documentation.php).

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
  mode: 'manual', // albo 'yolo'
  maxSteps: 40,
  maxMinutes: 5,
  confidence: 0.7,
  settleMs: 650,
  success: { type: 'text', value: 'Wynik: 10/10' },
});
// Z innego handlera, także podczas oczekiwania na API lub zgodę:
// await runner.stop();
// await runner.resume();
// console.log(Clickator.scan());
```

`start()` kończy się po zakończeniu/zatrzymaniu sesji. `transport(body, {apiKey, signal})` ma zwracać sparsowany JSON odpowiedzi DefAPI. `store` implementuje asynchroniczne `load()`, `save(state)` i `clear()`. `confirm(action)` zwraca boolean lub Promise<boolean>. Błędy działania są raportowane przez `onStatus`; błędy konfiguracji odrzucają Promise `start()`.

## Jak działa podejmowanie decyzji

### Logi requestów i odpowiedzi JEV

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
4. Drugie żądanie (`state.stage: action`) przekazuje pełny kontekst tylko wybranego komponentu oraz wyłącznie jego akcje. JEV wybiera ID akcji (`a…`) albo `blocked`. Nie może wybrać akcji innego komponentu ani zakończyć całego celu na podstawie tego lokalnego widoku. Integracja używa pytań `next: choice`, `achieved: noul`, endpointu `POST https://api.defapi.org/api/v1/decisions` i Bearer auth zgodnie z [dokumentacją JEV](https://defapi.org/api/model/en/typesafe/jev-1.13).
5. Sprawdzenie aktualności DOM po każdym etapie, pewności obu wyborów i ewentualnej zgody. Wykonanie **jednej** akcji, odczekanie i ponowny skan. Jeśli którykolwiek wybór jest poniżej progu, manualny pyta o zgodę na konkretną akcję, a YOLO zatrzymuje się. Limit kroków nadal liczy wykonane akcje, natomiast logi numerują osobno każde wywołanie API.

### Filtry i kolejność komponentów

Nie utrzymujemy sztywnej kolejki ID komponentów: identyfikatory obowiązują dla bieżącego skanu. Po zaznaczeniu filtra następuje nowy wybór komponentu na podstawie aktualnego stanu i historii (z opisem poprzedniego komponentu). Model może wybrać kolejny filtr, a następnie komponent zawierający przycisk „Filtruj”. Instrukcja dla JEV wskazuje, że samo zaznaczenie pól nie dowodzi zastosowania filtrów. Mały formularz może stanowić jeden komponent; jego fieldsety lub grupy ARIA mogą tworzyć osobne komponenty. Kolejne wybory pozwalają pracować wielokrotnie w tym samym komponencie.

Zwykle oznacza to dwa requesty na akcję, lecz mniejsze listy wyboru. Nie gwarantuje mniejszej sumarycznej liczby tokenów ani bezbłędnego planowania przez model. Log `request-N.json` zawiera `state.stage`, aby łatwo odróżnić oba etapy.

Tryb **manualny** bez pytania zmienia checkboxy (także odznacza), radio i role checkbox/radio/switch, jeśli decyzja osiąga ustawiony próg pewności. Poniżej progu także te akcje wymagają zgody, z pokazaniem kontekstu i pewności. Przyciski, linki i wybór opcji select zawsze wymagają zgody. Zmiana checkboxa może uruchomić handlery strony i spowodować nawigację — manualny nie izoluje skutków zdarzeń. **YOLO** wykonuje akcje bez zgody, jeśli osiągają próg; poniżej niego zatrzymuje sesję.

### Niska pewność decyzji

Domyślny próg wynosi 70%, dlatego odpowiedź z pewnością 60% nie kwalifikuje się do automatycznego wykonania. W panelu pole „Minimalna pewność decyzji (%)” pozwala ustawić np. 60 — decyzja równa progowi jest akceptowana. Zmiana obowiązuje po kliknięciu Start; Wznów używa konfiguracji zapisanej sesji. W API odpowiada temu `runner.start({ goal: '...', confidence: 0.6 })`.

Niższy próg dopuszcza mniej pewne wybory. Zamiast obniżać go dla wszystkich działań, możesz użyć trybu manualnego i zatwierdzać pojedyncze niepewne akcje. Ta zgoda nie obniża progu następnych decyzji ani nie omija sprawdzania aktualności DOM. Niepewne `done`/`blocked` nadal zatrzymuje sesję; próg oceny osiągnięcia celu `successThreshold` pozostaje osobnym ustawieniem. Wynik pewności modelu nie jest gwarancją poprawności akcji.

## Zakończenie

Najbardziej przewidywalny jest jawny warunek `success`:

- `text`: zebrany widoczny tekst zawiera podany fragment;
- `url`: bieżący pełny URL zawiera podany fragment;
- `selector`: selektor CSS wskazuje widoczny element (np. `.quiz-result.success`).

Warunek sprawdzany jest przed kolejnym wywołaniem API. Jeśli go podasz, model nie może zastąpić go własnym werdyktem. Wartość musi jednoznacznie oznaczać sukces; sam napis przycisku „Zakończ” nie jest dobrym warunkiem.

Bez jawnego warunku wymagane są dwie kolejne decyzje `done` z `achieved >= 0.97` i wystarczającą pewnością wyboru. Jest to heurystyczna ocena modelu, **nie dowód** poprawnego wykonania; dwa odczyty nie są niezależną weryfikacją. Komunikat panelu rozróżnia tę ocenę od spełnienia jawnego warunku.

Inne zakończenia nie oznaczają sukcesu: limit kroków/czasu, niska pewność, `blocked`, błąd API, dwie akcje bez zmiany obserwowanego stanu, powtarzana akcja w tym samym stanie, pięć nieaktualnych odpowiedzi z rzędu, odmowa lub Stop. Domyślne limity: 40 akcji i 5 minut; timeout żądania: 30 sekund. Błędy API nie uruchamiają automatycznych ponowień.

## Zakres MVP

- Standardowy DOM głównego dokumentu; brak obsługi iframe, shadow DOM stron, canvas, drag-and-drop i zdarzeń wymagających `isTrusted`.
- Nie generuje tekstu do inputów/textarea i nie obsługuje uploadu. JEV wybiera spośród podanych opcji; wolny tekst wymagałby osobnego mechanizmu.
- Skan obejmuje do 160 kontrolek i 240 akcji na komponent; lokalnie zbierany tekst strony do 10 000 znaków, grupy do 1600. Do JEV trafiają ograniczone widoki opisane powyżej. Duże formularze mogą wymagać zawężenia skanowania. Panel sygnalizuje skrócenie listy. Warunek tekstowy dotyczy lokalnie zebranego fragmentu tekstu; dla długich stron użyj selektora.
- Okres oczekiwania po akcji jest konfigurowalny; wolno aktualizujące się aplikacje mogą wymagać większego `settleMs`. Stale zmieniający się tekst może uniemożliwić wykonanie decyzji.
- Linki otwierane są w tej samej karcie; popupów otwieranych kodem strony nie przejmuje. Pełna nawigacja wymaga uruchomienia wrappera także na stronie docelowej. Bez niego kontynuacja nie nastąpi.
- Tekst strony i opis kontrolek trafiają do DefAPI. Hasła, pliki i wartości pól tekstowych nie są pobierane, lecz widoczny tekst może zawierać dane osobowe. Tekst strony jest oznaczany jako niezaufany, ale prompt nie gwarantuje odporności na prompt injection. Nie przekazuj klucza do kontekstu JS strony; preferuj sandbox Tampermonkey.
- Nie wykonano wywołania płatnego JEV ani testu integracyjnego w Tampermonkey — potrzebny jest klucz i docelowa strona. Schemat API zweryfikowano w dokumentacji, wykonanie i scenariusze zatrzymania sprawdzono lokalnymi testami.

### Automatyczne przejście z kategorii do koszyka

Wrapper Tampermonkey musi uruchamiać `Clickator.mount()` na każdej stronie zadania (`@match` obejmujący kategorię, produkt i koszyk; `@run-at document-idle`). Klucz z buildu lub `getApiKey` musi być dostępny po przeładowaniu. W trybie YOLO zadanie np. „Znajdź Samsung S26 i dodaj go do koszyka” kontynuuje się po nawigacji z tą samą historią i pozostałym budżetem kroków/czasu. Tryb manualny wznawia analizę, ale nadal wymaga potwierdzenia kliknięć. Samo dodanie do koszyka nie oznacza złożenia zamówienia.
