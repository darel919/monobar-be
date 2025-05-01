
# myFlix

myFlix is a backend for myFlix. myFlix takes Emby complicated API and converts it to an easy to understand Endpoint.

## Usage/Examples
Using JavaScript Fetch API to get available libraries data
```javascript
fetch('https://api.darelisme.my.id/libraries')
  .then(response => response.json())
  .then(data => console.log(data))
  .catch(error => console.error('Error:', error));

```
using jQuery ajax API
```jquery
$.ajax({
  url: 'https://api.darelisme.my.id/libraries',
  method: 'GET',
  success: function(data) {
    console.log(data);
  },
  error: function(xhr, status, error) {
    console.error('Error:', error);
  }
});

```
using PHP cURL
```php
$curl = curl_init();

curl_setopt_array($curl, array(
  CURLOPT_URL => 'https://api.darelisme.my.id/libraries',
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 30,
  CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
  CURLOPT_CUSTOMREQUEST => 'GET',
));

$response = curl_exec($curl);
$err = curl_error($curl);

curl_close($curl);

if ($err) {
  echo 'cURL Error #: ' . $err;
} else {
  echo $response;
}

```




## Authors

- [@darel919](https://www.github.com/darel919)

