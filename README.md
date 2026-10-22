# Filter Everything Batch Apply — prototipo 0.1.4

Addon independiente para WooCommerce + BeTheme + Filter Everything (edición gratuita).

## Objetivo

Las casillas de **Color, Talla, Marca y Categoría** se seleccionan localmente, sin peticiones AJAX por clic. El filtro **Precio** usa dos campos numéricos y un deslizador visual de dos extremos, sin eventos AJAX. Un botón propio **Aplicar filtros** genera una única navegación por URL y deja que Filter Everything procese la consulta.

**No se han modificado archivos de WooCommerce, BeTheme ni Filter Everything.**

## Instalación

1. Probar primero en **staging** y hacer copia de seguridad.
2. Subir el ZIP mediante *Plugins > Añadir nuevo > Subir plugin* y activarlo.
3. Mantener Filter Everything activado con su Filter Set y el widget dentro de la sidebar *Filtros tienda*.
4. Mantener el Off-canvas de BeTheme en `/shop/`.
5. El addon añade sus propios botones **Aplicar filtros** y **Restablecer** al final del widget. Oculta el botón nativo únicamente si se inicializa correctamente.
6. Probar desde cero en `/shop/` y en categorías de producto.

## Notas y límites de esta primera versión

- **Prototipo no verificado en el sitio real**: los selectores se han inferido de los fragmentos del DOM obtenidos por la consola. Pueden necesitar pequeños ajustes.
- Está adaptado expresamente a `pa_colores`, `pa_talla`, `product_brand` y `product_cat`, junto con sus parámetros `filtro_color`, `filtro_talla`, `filtro_marca`, `filtro_categoria`. Si el catálogo cambia sus filtros, se ajusta la constante `FIELDS` en JS.
- El precio utiliza `min_filtro_precio` y `max_filtro_precio`. El slider nativo del plugin se oculta para no disparar AJAX; se muestra un control local alternativo. Los límites se obtienen de `data-min` y `data-max` en los controles existentes. **Con filtros cruzados sin recálculo, esos límites pueden no reflejar todas las combinaciones posibles**, algo coherente con el objetivo de no hacer peticiones antes de pulsar Aplicar.
- «Restablecer» elimina en un clic filtros **pendientes y ya aplicados**; cuando existen criterios en la URL hace una única navegación al catálogo sin filtros. Esto implica la espera normal del servidor al recargar.
- Se conserva `orderby` y el resto de parámetros ajenos a estos filtros, y se reinicia la paginación al aplicar.
- Se restablecen al cargar las cookies visuales `wpcContainersStatus` / `wpcMoreLessStatus`; se fuerzan abiertas las secciones plegables y se muestra el estado reducido de More/Less. Se mantiene pendiente el estilo definitivo del panel y una sincronización de alternativas de jerarquía de categorías.
- El plugin todavía **no cuenta con ensayos E2E contra esta web**. Verificar resultados, navegación, teclado, precio, paginación, filtros combinados y móviles antes de producción.
- Si no funciona, **desactivar este addon** restaura la interfaz original del plugin.

## Casos de prueba mínimos

1. Abrir `/shop/`, marcar varios colores y tallas: **cero peticiones intermedias** en Network.
2. Desmarcar opciones y verificar que se actualizan sus casillas.
3. Cambiar precio mínimo y máximo en los controles locales: sin peticiones.
4. Pulsar «Aplicar filtros»: **una navegación** a la URL correcta y productos filtrados.
5. Reabrir panel, mantener selecciones, restablecer pendientes y aplicar.
6. Comprobar categorías, paginación, ordenación y móviles.

## Diagnóstico de rendimiento (fuera de alcance)

El sitio ha mostrado TTFB de 14–15 s sin filtros y hasta 20 s con filtros, por lo que esta mejora evita las esperas entre selecciones, pero no resuelve la latencia de la petición final. El responsable del hosting debería revisar caché, PHP y MySQL.

## Ajustes de 0.1.1

- Ocultar el contenido nativo completo de Precio (deslizador y campos) conservando el encabezado plegable; evita doble control.
- Controles locales de precio más estrechos y un único deslizador de dos extremos; evitar cortes laterales.
- Ocultar controles originales Aplicar/Restablecer, incluida su envoltura flotante, y el enlace administrativo de edición dentro del widget.
- Botones propios más compactos y fijación adhesiva cuando el scroll del panel lo permita.
- **No probado en el DOM real después de modificar el código**. Verificar que el encabezado plegable conserva su funcionalidad, que el precio se aplica y que desaparece el control original.

La apertura inicial de Folding y el reinicio de More/Less se incorporan en 0.1.3.

## Ajustes de 0.1.2

- El panel de acciones se separa 12 px de los laterales y 10 px del fondo al quedar adherido, y su ancho se calcula automáticamente dentro de la barra lateral.
- Contenedor de botones con borde, esquinas redondeadas y relleno para evitar cortes visuales.
- Sin cambios en la lógica de aplicación, precio, casillas o filtros.
- La cabecera del plugin conserva `Author: Custom`. Si WordPress muestra «Eliseu» como autor de un conjunto de filtros, es un dato distinto al autor del plugin.

## Ajustes de 0.1.3

- Autor del plugin establecido explícitamente como **Eliseu Martínez** en la cabecera estándar de WordPress.
- Los filtros configurados como **Plegables** empiezan abiertos tras cargar la página. Siguen pudiéndose abrir y cerrar manualmente durante la visita.
- **More/Less** empieza en «Ver más», mostrando la cantidad predeterminada de **5 términos**; no se modifica el número de elementos permitido por Filter Everything.
- Se borran exclusivamente las cookies de presentación `wpcContainersStatus` y `wpcMoreLessStatus` al entrar al catálogo (con un script temprano) y se fuerzan las clases iniciales del widget. **No se borran los parámetros de filtro ni las selecciones aplicadas**.
- El restablecimiento también se hace en nuevas instancias del widget creadas después de una actualización del DOM y al volver por la caché atrás/adelante del navegador. No se fuerza el estado de forma continua durante la interacción.
- Si un navegador o una caché sirve HTML/JS desactualizado, vaciar caché y comprobar primero en una ventana privada.
- La nueva lógica se ha validado sintácticamente y mediante inspección del marcado de Filter Everything 1.9.0. **Hay que verificar visualmente el estado inicial en la instalación real** (especialmente con términos ya seleccionados).

## Ajustes de 0.1.4

- Precio: incremento de **1 €** para ambos controles numéricos y extremos del deslizador. Límites redondeados a euros enteros.
- Restablecer: tanto la selección pendiente como la aplicada se limpian en un clic. Si la URL contiene filtros, se realiza una única navegación para quitar los parámetros y chips. Se conservan parámetros ajenos a los filtros (p. ej. ordenación) y el contexto del archivo. Al pulsar Aplicar, un rango de precio ya aplicado se conserva si no se modifica expresamente.
- Se oculta el resumen repetido de términos seleccionados bajo los títulos de secciones plegadas (p. ej. «— Amarillo»), dado que los chips activos siguen mostrándose en el catálogo.
- La caja de botones **continúa adhesiva** (`position: sticky`) a propósito para que «Aplicar filtros» esté accesible al desplazarse. Se puede cambiar a estática si se prefiere.
- Esta corrección requiere probarse en staging, especialmente los filtros aplicados, los cambios locales no aplicados, el precio y el panel Off-canvas.
